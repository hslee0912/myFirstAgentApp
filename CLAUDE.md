# myFirstAgentApp

자연어 요구사항 → CodeChecker → BE/FE Agent → 3단계 Lint 게이트 → 자동 재시도 루프로 동작하는 멀티 에이전트 코드 생성 PoC. 회원가입·로그인 같은 기능을 시스템이 직접 작성하고 자체 검증한 뒤 수용한다.

## 파이프라인 (이 다이어그램이 핵심)

```
사용자 요청
  └─ Orchestrator (LLM 안 부름, 컨트롤러)
      ├─ Phase 1  CodeChecker (LLM)    → FE/BE/BOTH 분류, spec + api_contract 생성
      ├─ Phase 2  BE Agent (LLM)       → BE/ 코드 + Jest 테스트
      ├─ Phase 3  FE Agent (LLM)       → FE/ 코드 + Vitest+RTL 테스트
      ├─ Phase 4  Lint Agent (LLM X)   → eslint → build → tests
      │                                    (VALIDATION_MODE=off면 skip,
      │                                     log_task_state 자동 SUCCESS)
      ├─ Phase 5  verdict (LLM X)      → PASS / FAIL / ERROR / CONTINUE
      │                                    CONTINUE면 fix_instructions 들고
      │                                    Phase 2/3로 다시 진입
      ├─ Phase 6  finalize (LLM X)     → log_agent_decisions UPDATE,
      │                                    log_agent_runs UPDATE
      └─ Phase 7  auto-commit (LLM X)  → PASS + COMMIT_MODE=auto면
                                           git add BE/ FE/ + git commit
                                           (push는 절대 안 함, 사람이 수행)
```

LLM은 **CodeChecker, BE Agent, FE Agent 안에서만** 호출됨.
Orchestrator와 Lint Agent는 결정론적.

## 컴포넌트

| 파일 | LLM | 역할 |
|---|---|---|
| `agents/orchestrator.js` | ❌ | Phase 흐름, verdict 평가 |
| `agents/codechecker_agent.js` | ✅ | log_agent_decisions / log_task_state INSERT |
| `agents/be_agent.js` | ✅ | BE/ 쓰기. 매 호출 시 convention 읽음 |
| `agents/fe_agent.js` | ✅ | FE/ 쓰기. 매 호출 시 convention 읽음 |
| `agents/lint_agent.js` | ❌ | log_task_state UPDATE 전용 |
| `lib/db.js`, `logger.js` | ❌ | mysql2 + 로그 헬퍼 |
| `lib/llm.js` | — | @anthropic-ai/sdk 래퍼 + jsonrepair 폴백 |
| `lib/bootstrap.js` | ❌ | 멱등 FE/BE 스캐폴딩 |
| `lib/stack.js` | ❌ | `lib/stack.config.json` 로더 |

## 스택 (단일 원천: `lib/stack.config.json`)

| 영역 | 스택 | 테스트 | allowedDeps |
|---|---|---|---|
| BE | Express + bcrypt + mysql2 | Jest + Supertest | express, mysql2, bcrypt, cors, dotenv, jest, supertest |
| FE | Vite + React 18 | Vitest + RTL (jsdom) | react, react-dom, vite, vitest, jsdom, @testing-library/* |

스택 교체 시 (예: BE → Spring Boot) 다음 두 곳만 수정:
1. `lib/stack.config.json` (해당 영역 블록)
2. `lib/stack_templates/<AREA>/` (placeholder 파일)

Agent 코드, lint 로직, bootstrap은 전부 그대로.

## DB (단일 MySQL: `myfirstagentapp_db`)

| 테이블 | INSERT 주체 | UPDATE 주체 |
|---|---|---|
| `app_users` | BE 런타임 | — |
| `log_agent_runs` | 각 Agent (자기 row) | 각 Agent (자기 row만) |
| `log_agent_decisions` | CodeChecker (task당 1) | Orchestrator (final_verdict) |
| `log_task_state` | CodeChecker (task당 1~2) | Lint Agent 전용 |

`.env` (DB_HOST/PORT/USER/PASSWORD/NAME)로 접속.
모든 `dotenv.config()` 호출은 **반드시 `{ override: true }`** — 시스템 env에 빈 `ANTHROPIC_API_KEY`가 잡혀 있으면 .env가 묻히는 현상 방지.

## Verdict 값 의미

`log_agent_decisions.final_verdict` 가능 값:

| 값 | 의미 | 어디서 결정 |
|---|---|---|
| `IN_PROGRESS` | task 시작됨, 아직 종료 안 됨 | CodeChecker INSERT 시점 (Phase 1) |
| `PASS` | 모든 영역(BE/FE) `log_task_state.status='SUCCESS'`. `COMMIT_MODE=auto`면 Phase 7에서 자동 commit 발동. `VALIDATION_MODE=off`면 검증 없이 PASS (코드 미검증 상태) | Orchestrator Phase 5 ② |
| `FAIL` | Stage 3 실패 또는 `retry_count >= 3` | Orchestrator Phase 5 ③, ④ |
| `ERROR` | 어느 Agent의 `log_agent_runs.status='FAILED'` (예외 발생) | Orchestrator Phase 5 ① |

종료 우선순위: ERROR > PASS > FAIL(STAGE3) > FAIL(retry 초과) > 다음 라운드.

## 절대 규칙 (위반 금지)

1. **폴더 격리** — BE Agent는 `BE/`만, FE Agent는 `FE/`만 수정. `validatePaths` 런타임 검증.
2. **보호 파일** (`stack.config.json` `protectedConfigFiles`) — Agent는 `package.json`, `vite.config.js`, `index.html`, `.eslintrc.json` 등을 절대 작성 못함. `validatePaths`가 차단.
3. **새 의존성 금지** — `allowedDeps`만 사용. 부족하면 `notes`에 사유만 적고 코드 만들지 말 것. 매니페스트 수정 금지.
4. **Placeholder 보존** (Convention §9) — bootstrap이 깐 `server.test.js`/`App.test.jsx`는 그대로 유지. 새 코드가 거기에 맞춰야 함.
5. **dotenv override** — 모든 `dotenv.config()` 는 `{ override: true }`.
6. **Stage 3 (테스트) 실패 = 즉시 FAIL** — 재시도 없음. Stage 1/2 실패만 최대 3회 재시도. (VALIDATION_MODE=on일 때만 적용 — off면 Phase 4 자체가 안 돌아감)
7. **파이프라인 자동 commit (`COMMIT_MODE`)** — `.env`의 `COMMIT_MODE`로 orchestrator의 자동 commit 여부 토글:
   - `COMMIT_MODE=auto` (기본) → verdict=PASS일 때 orchestrator가 `BE/`+`FE/`만 자동 commit. **push는 항상 사람이 수행** (orchestrator는 절대 push 안 함).
   - `COMMIT_MODE=manual` (또는 `auto`가 아닌 모든 값) → 자동 commit 안 함, 사람이 commit/push 모두 수행.
   - 사람의 `git commit`/`git push`는 어떤 모드에서도 검사·차단 없음.
   - 자동 commit 메시지 포맷: `auto: <task_id> — <user_request 첫 80자>`
8. **검증 토글 (`VALIDATION_MODE`)** — `.env`의 `VALIDATION_MODE`로 Phase 4 (Lint Agent) 실행 여부 토글:
   - `VALIDATION_MODE=on` (기본) → Phase 4 정상 실행 (eslint → build → tests), 기존 verdict 흐름 그대로.
   - `VALIDATION_MODE=off` (또는 `on`이 아닌 모든 값) → Phase 4 통째로 skip, `log_task_state`를 자동 SUCCESS 처리 → verdict는 PASS로 흐를 가능성 높음. 코드 미검증 상태로 디스크에 떨어짐.
   - **안전장치는 모드 무관 항상 켜짐**: `validatePaths`(폴더 격리), `protectedConfigFiles`(보호 파일) 등 규칙 #1·#2 검증은 OFF 모드에서도 동작.
   - `COMMIT_MODE`와 독립 — `VALIDATION_MODE=off` + `COMMIT_MODE=auto`면 검증 안 된 코드의 자동 commit 발생, 사용자 책임.
   - 의미: "결정론적 *검증*"만 끄고 "결정론적 *제어흐름*"은 유지 → LLM 출력 ablation/디버깅 모드.

## 사람·Claude 직접 편집 vs Agent 자동 생성

위 절대 규칙 #1, #2의 `validatePaths` 검증은 **LLM Agent가 코드를 응답으로 내놓을 때** 적용된다. 사람이 IDE로 직접 편집하거나, Claude(어시스턴트)가 Edit/Write 도구로 BE/, FE/, 또는 protected 파일을 수정하는 것은 **정상적인 개발 작업으로 허용**된다.

- Agent 산출물 → `validatePaths` 통과해야 디스크에 반영
- 사람·Claude 직접 편집 → 자유. commit/push 시점 검사·차단 없음 (pre-push gate 제거됨).

자동 commit은 오직 **파이프라인이 만든 변경분(BE/+FE/)** 에만 적용된다. 사람이 손본 코드를 자동 commit에 끼워넣으려면 orchestrator를 한 번 통과시켜 PASS를 받아야 한다 — 그렇지 않으면 사람이 직접 commit하면 됨 (모드 무관 자유).

## 표준 명령

```bash
# DB 초기화
npm run init-db

# 파이프라인 실행
npm start                                          # 기본 시나리오 (회원가입)
node agents/orchestrator.js "기능 요청 자연어..."   # 커스텀
# → verdict=PASS && COMMIT_MODE=auto면 종료 직전 BE/+FE/ 자동 commit (push 안 함)

# 검증 끄고 빠르게 LLM 원시 출력만 보고 싶을 때 (ablation)
VALIDATION_MODE=off node agents/orchestrator.js "..."

# 개별 테스트 실행
cd BE && npx jest --runInBand
cd FE && npx vitest run
```

## 정상 소요 시간

Orchestrator end-to-end 한 번에 약 **3~5분**:
- CodeChecker ~30s
- BE Agent ~60–90s
- (BE↔FE 사이 15s 쿨다운, rate limit 회피)
- FE Agent ~60–90s
- Lint Agent ~30s × 영역
- (재시도 라운드면 라운드 사이 30s 쿨다운 추가)

5분 이상 멈춘 듯 보여도 정상일 수 있음 — `tail -f /tmp/orchestrator_*.log` 또는 `log_agent_runs` 조회로 진행 상태 확인.

## 자주 하는 작업

### 새 기능 추가
1. `node agents/orchestrator.js "..."` — 파이프라인이 end-to-end로 돌아감.
2. `COMMIT_MODE=auto`(기본)이면 PASS 시 `BE/`+`FE/`가 자동 commit됨 (로컬에만).
3. 사람이 변경 내용 확인 후 `git push` (검사·차단 없음).

### 실패한 실행 진단
1. 콘솔의 `task_id` 확인.
2. `log_agent_runs WHERE task_id=...` 조회 → 어느 Agent가 실패했는지.
3. LLM JSON 깨졌으면 raw 응답이 `os.tmpdir()/llm-bad-response-*.txt`에 덤프됨.
4. `log_task_state`의 `failed_stage`, `fix_instructions`, `stage_logs` 확인.

### Phase 7 자동 commit 진단
verdict=PASS인데 commit이 생기지 않았을 때 콘솔 로그를 확인. 자동 commit이 skip되는 모든 경우:

| 케이스 | 콘솔 메시지 | 대응 |
|---|---|---|
| `COMMIT_MODE` ≠ `auto` | `[commit] COMMIT_MODE=... — auto-commit skipped` | `.env`에서 `COMMIT_MODE=auto`로 |
| git repo 아님 | `[commit] not a git repository — auto-commit skipped` | `git init` 후 재실행 |
| BE/FE 둘 다 없음 | `[commit] neither BE/ nor FE/ exists — auto-commit skipped` | bootstrap 확인 |
| BE/FE에 변경 0 | `[commit] no changes in BE/ or FE/ — auto-commit skipped` | 정상 (Agent가 실제 코드 수정 안 함) |
| `git add` 실패 | `[commit] git add failed: ...` | 권한·잠금 등 OS 문제 |
| `git commit` 실패 | `[commit] git commit failed: ...` | git config user.name/email, pre-commit hook 등 |

자동 commit 실패는 verdict에 영향을 주지 않음 — verdict는 PASS 그대로, commit만 안 만들어짐.

### 스택 교체
README의 "스택 변경 체크리스트" 섹션 참조.

## 컨벤션

- `rules/code_convention.md` — BE/FE Agent가 매 LLM 호출 시 읽음. 명명 규칙, 보안(bcrypt, prepared statement), API 응답 형식, placeholder 보존, 스택 일관성 포함.
- API 응답 형식: 모든 엔드포인트가 `{ success: bool, data: any, error?: string }` 따름.
- **env 변수 추가/수정**: 코드에서 새 env를 도입할 때 `.env.example`과 `.env`를 **반드시 짝으로** 갱신. `.env.example`만 손보면 사용자가 토글하려 할 때 실제 `.env`에 변수가 없어 혼란 — runtime이 읽는 건 `.env`임.

## 최근 결정 (타임라인)

- 2026-05-08  (TBD)    VALIDATION_MODE 도입 (off면 Phase 4 skip, ablation/디버깅용)
- 2026-05-07  6a778d9  CLAUDE.md docs 정리 (Phase 7, troubleshooting 표 추가)
- 2026-05-07  b6212e1  COMMIT_MODE 도입 (PASS+auto 시 BE/FE 자동 commit), pre-push gate 제거
- 2026-05-07  b41aee3  login + LoginForm 추가 (signup 보존)
- 2026-05-07  2613b5f  jsonrepair 폴백을 LLM JSON 파서에 추가
- 2026-05-07  3597f77  pre-push 게이트 (main push는 verdict=PASS 필요)
- 2026-05-07  4d7faf5  initial commit (전체 시스템)

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Bugs/errors → invoke /investigate
- QA/testing → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Code quality dashboard → invoke /health
