# Architecture

이 문서는 myFirstAgentApp의 컴포넌트, 데이터 모델, verdict 평가 정책 등 시스템 구조를 다룹니다. 절대 규칙·핵심 다이어그램은 [CLAUDE.md](../CLAUDE.md)에 있고, 운용/명령은 [OPERATIONS.md](OPERATIONS.md)에 있습니다.

## 컴포넌트

| 파일 | LLM | 역할 |
|---|---|---|
| `agents/orchestrator.js` | ❌ | Phase 흐름, verdict 평가, 모드/모델 로그 |
| `agents/codechecker_agent.js` | ✅ `CODECHECKER_MODEL` | log_agent_decisions / log_task_state INSERT |
| `agents/be_agent.js` | ✅ `BE_AGENT_MODEL` | BE/ 쓰기. 매 호출 시 convention 읽음 |
| `agents/fe_agent.js` | ✅ `FE_AGENT_MODEL` | FE/ 쓰기. 매 호출 시 convention 읽음 |
| `agents/lint_agent.js` | ❌ | log_task_state UPDATE 전용 |
| `agents/deploy_agent.js` | ❌ | Phase 8: docker compose up + teardown. log_agent_runs row 1개 (`agent_name='Deploy'`) |
| `agents/test_agent.js` | ❌ | Phase 9: api_test.runContract 호출. log_agent_runs row 1개 (`agent_name='PostTest'`) |
| `lib/db.js`, `logger.js` | ❌ | mysql2 + 로그 헬퍼 |
| `lib/llm.js` | — | @anthropic-ai/sdk 래퍼 + jsonrepair 폴백 + `resolveModel()` |
| `lib/api_test.js` | ❌ | api_contract 로드(+ split layout expansion) + simple JSON Schema validator + fetch 실행. test_agent의 helper |
| `lib/bootstrap.js` | ❌ | 멱등 FE/BE 스캐폴딩 (Dockerfile, .dockerignore도 자동 복사) |
| `lib/stack.js` | ❌ | `lib/stack.config.json` 로더 |

## LLM 모델 해석 순서 (각 Agent별)

1. **`<AGENT>_MODEL`** env (예: `BE_AGENT_MODEL`) — 비어있지 않으면 우선
2. **`ANTHROPIC_MODEL`** env — 전역 fallback
3. **`claude-sonnet-4-5`** — 하드코딩 마지막 보루

→ Agent별로 다른 모델 사용 가능. 예: CodeChecker는 빠른 Haiku, BE/FE는 Sonnet.

## API contract 레이아웃 (split: index + router/)

```
shared/
├── api_contract.json    ← index. { version, base_url, endpoints: [{name, path, method, description}] }
└── router/
    └── <name>.json      ← per-endpoint detail. { path, method, description?, request, responses }
```

- **`api_contract.json` (index)**: 어떤 endpoint가 정의돼 있나 한눈에 — path/method/한 줄 description만. base_url은 BE가 `app.use` prefix로 깔고 Phase 9도 fetch URL 만들 때 결합.
- **`router/<name>.json` (detail)**: 각 endpoint의 request/responses schema. `name`은 snake_case로 path에서 유도 (`/auth/signup` → `auth_signup`).
- CodeChecker가 LLM 응답의 `api_contract` + `router_details` 두 필드를 받아 위 두 곳에 따로 write. 시작 시 기존 `shared/router/`의 stale `.json`은 새 contract에 없는 것 자동 정리.
- `lib/api_test.js`의 `normalizeContract(contract, { routerDir })`이 index의 각 entry를 detail file로 inline 확장. 이 한 함수가 disk 형식(split)과 in-memory 형식(full)을 연결.
- BE/FE Agent의 `readApiContractIfAny()`도 같은 `normalizeContract`를 호출하므로 prompt엔 항상 full form이 들어감 — Agent 코드는 split layout을 신경 쓸 필요 없음.
- 새 endpoint 추가는 CodeChecker가 자동. 사람이 직접 추가하려면 (1) `shared/router/<name>.json` 파일 만들고 (2) `shared/api_contract.json` `endpoints` 배열에 index entry 한 줄 추가.

## 스택 (단일 원천: `lib/stack.config.json`)

| 영역 | 스택 | 테스트 | allowedDeps |
|---|---|---|---|
| BE | Express + bcrypt + mysql2 | Jest + Supertest | express, mysql2, bcrypt, cors, dotenv, jest, supertest |
| FE | Vite + React 18 | Vitest + RTL (jsdom) | react, react-dom, vite, vitest, jsdom, @testing-library/* |

스택 교체 시 (예: BE → Spring Boot) 다음 두 곳만 수정:
1. `lib/stack.config.json` (해당 영역 블록)
2. `lib/stack_templates/<AREA>/` (placeholder 파일)

Agent 코드, lint 로직, bootstrap은 전부 그대로. 자세한 절차는 [README.md](../README.md)의 "스택 변경 체크리스트".

## DB (단일 MySQL: `myfirstagentapp_db`)

| 테이블 | INSERT 주체 | UPDATE 주체 |
|---|---|---|
| `app_users` | BE 런타임 | — |
| `log_agent_runs` | 각 Agent (자기 row) | 각 Agent (자기 row만) |
| `log_agent_decisions` | CodeChecker (task당 1) | Orchestrator (final_verdict) |
| `log_task_state` | CodeChecker (task당 1~2) | Lint Agent 전용 |

`.env` (DB_HOST/PORT/USER/PASSWORD/NAME)로 접속.
모든 `dotenv.config()` 호출은 **반드시 `{ override: true }`** — 시스템 env에 빈 `ANTHROPIC_API_KEY`가 잡혀 있으면 .env가 묻히는 현상 방지. (단, 이 정책은 CLI inline env override를 막는 부작용이 있어 향후 변경 검토 — `ROADMAP.md` 참조)

## Verdict 값 의미

`log_agent_decisions.final_verdict` 가능 값:

| 값 | 의미 | 어디서 결정 |
|---|---|---|
| `IN_PROGRESS` | task 시작됨, 아직 종료 안 됨 | CodeChecker INSERT 시점 (Phase 1) |
| `PASS` | 모든 영역(BE/FE) `log_task_state.status='SUCCESS'` AND (`DEPLOY_MODE=off` OR Phase 8 Deploy SUCCESS + Phase 9 PostTest SUCCESS). `COMMIT_MODE=auto`면 Phase 7에서 자동 commit 발동. `DEPLOY_MODE=on` + PASS면 Phase 7.5에서 docker compose down. | Orchestrator Phase 5 ② → `evaluateFinalVerdict` (Phase 8/9 결합) |
| `FAIL` | Stage 3 실패 또는 `retry_count >= 3` | Orchestrator Phase 5 ③, ④ |
| `ERROR` | 어느 Agent의 `log_agent_runs.status='FAILED'` (예외 발생) | Orchestrator Phase 5 ① |

종료 우선순위: ERROR > PASS > FAIL(STAGE3) > FAIL(retry 초과) > 다음 라운드.

## Phase 흐름 상세

CLAUDE.md의 다이어그램이 핵심 요약. 본 섹션은 Phase별 부가 정보.

### Phase 0 — Bootstrap
- `lib/bootstrap.js` 가 멱등하게 동작
- 처음이면 `lib/stack_templates/<AREA>/`의 placeholder 복사
- 의존성 없으면 `npm install` 실행
- 보호 파일(`package.json`, `vite.config.js` 등) 한 번 깔리면 Agent가 못 건드림

### Phase 1 — CodeChecker
- 자연어 요구사항 → `targets` (FE/BE/BOTH) 분류
- `fe_spec`, `be_spec`, `api_contract` 생성
- `log_agent_decisions` INSERT (verdict='IN_PROGRESS'로 시작)
- `log_task_state` INSERT (BE/FE 각 1행, status='PENDING')

### Phase 2/3 — BE/FE Agent
- BE 먼저, FE 나중 (라운드 내)
- `mode: 'initial'` 또는 `'retry'` (재시도 시 `fix_instructions` + `allowed_paths` 전달)
- 각 Agent는 `rules/common.md` + `rules/<area>.md` 읽고 system prompt에 주입
- LLM 호출 → JSON 파싱 → `validatePaths` → 디스크에 쓰기
- BE↔FE 사이 `LLM_INTER_CALL_MS` (기본 15s) 쿨다운

### Phase 4 — Lint
- `VALIDATION_MODE=on`면 stage 1 (eslint) → 2 (build) → 3 (tests) 순차
- `VALIDATION_MODE=off`면 통째로 skip, `log_task_state.status='SUCCESS'` 직접 UPDATE
- Stage 1/2 실패 → `retry_count++`, `failed_stage` 기록, fix_instructions 빌드
- Stage 3 실패 → 즉시 FAIL 종료 (재시도 없음)

### Phase 5 — Verdict 평가
- 우선순위 단일 평가 (위 표 참조)
- CONTINUE면 round 증가 후 라운드 사이 `LLM_INTER_ROUND_MS` (기본 30s) 쿨다운

### Phase 6 — Finalize
- `log_agent_decisions` UPDATE (`final_verdict`, `final_result_text`)
- Orchestrator의 `log_agent_runs` UPDATE
- DB 연결 close

### Phase 7 — Auto-commit (선택적)
- `verdict=PASS && COMMIT_MODE=auto` 일 때만
- `git add BE/ FE/` → `git diff --cached --quiet` → 변경 있으면 `git commit`
- `git push`는 절대 안 함 (사람 영역)

### Phase 8 — Deploy Agent (결정론, 선택적)
- 1차 verdict가 PASS일 때만 1회 실행 (D25=B). FAIL/ERROR면 skip.
- `DEPLOY_MODE=off`면 SUCCESS+skipped로 자동 통과 (`output_json.skipped='DEPLOY_MODE=off'`).
- 호출 시퀀스: Docker 설치 check (D27=A) → **port preflight (자동 fallback, D34)** → pre-cleanup (D6=B) → `docker compose up --build --detach [--wait]` (timeout `DEPLOY_TIMEOUT_SEC`) → output_json 분기 (D31=C: PASS는 가벼움 / FAIL은 service별 logs).
- **Port preflight**: 매 실행 시작 시 `DEPLOY_PORT_{DB,BE,FE}` 호스트 포트 3개를 `net.createServer().listen(port)`로 probe. 충돌이면 `+1..+20` 시도 후 첫 빈 포트로 fallback. `process.env` 갱신 후 compose 호출(`${DEPLOY_PORT_*}` substitution)과 Phase 9 PostTest (`baseUrl`) 가 같은 새 값 공유. fallback 발생 시 console에 `.env` 영구 설정 힌트 출력. 윈도우 모두 실패 시 `failed_stage='port_preflight'` FAIL. 자세한 내용은 [OPERATIONS.md](OPERATIONS.md) "포트 충돌 시" 참조.
- compose CLI: v2 (`docker compose`) 우선, v1 fallback. `--wait`는 v2 전용 (mysql healthcheck 통과까지 대기 — D14=B 시너지).

### Phase 9 — PostTest Agent (결정론, 선택적)
- Phase 8이 SUCCESS일 때만 호출. SKIPPED면 자체적으로 SUCCESS+skipped 반환.
- `lib/api_test.runContract({ baseUrl: 'http://localhost:${DEPLOY_PORT_BE}' })` 한 번 호출 (timeout `POSTTEST_TIMEOUT_SEC`).
- 검증 통과 기준 (D4): response status가 contract의 `responses` 키 중 하나 + body가 그 status의 schema에 일치. "200 필수" 아님 — 401도 declared면 schema 통과 시 PASS.
- output_json: PASS면 compact `{ pass, total, passed, duration_ms, baseUrl }`. FAIL이면 + `results` (per-endpoint trace + errors).

### Phase 7.5 — Deploy Teardown (D6=B PASS branch)
- final verdict가 PASS이고 `DEPLOY_MODE=on`일 때만 `deployAgent.teardown()` 호출 (= `docker compose down --remove-orphans`).
- FAIL/ERROR면 컨테이너 보존 — 학생이 `docker logs`로 디버깅 가능.

## 재시도 부분수정 정책

Lint가 Stage 1 또는 Stage 2에서 fail하면 Orchestrator가 다음 라운드에 BE/FE Agent를 **`retry` 모드**로 호출:
- `existing_files`: 현재 디스크의 파일 스냅샷
- `allowed_paths`: `fix_instructions`에서 추출한 파일 경로 + 짝 테스트 파일
- `fix_instructions`: Lint Stage의 stdout/stderr 요약
- Agent는 `allowed_paths` 외의 파일을 수정하면 안 됨. Orchestrator의 `validatePaths`가 응답 검증.
