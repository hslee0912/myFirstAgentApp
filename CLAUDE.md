# myFirstAgentApp

자연어 요구사항 → CodeChecker → BE/FE Agent → 3단계 Lint 게이트 → 자동 재시도 루프로 동작하는 멀티 에이전트 코드 생성 PoC. 회원가입·로그인 같은 기능을 시스템이 직접 작성하고 자체 검증한 뒤 수용한다.

## 파이프라인 (이 다이어그램이 핵심)

```
사용자 요청
  └─ Orchestrator (LLM 안 부름, 컨트롤러)
      ├─ Phase 1  CodeChecker (LLM)   → FE/BE/BOTH 분류, spec + api_contract 생성
      ├─ Phase 2  BE Agent (LLM)      → BE/ 코드 + Jest 테스트
      ├─ Phase 3  FE Agent (LLM)      → FE/ 코드 + Vitest+RTL 테스트
      ├─ Phase 4  Lint Agent (LLM X)  → eslint → build → tests
      └─ Phase 5  verdict (LLM X)     → PASS / FAIL / ERROR / CONTINUE
                                          CONTINUE면 fix_instructions 들고
                                          Phase 2/3로 다시 진입
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
| `lib/check_orchestrator_pass.js` | ❌ | pre-push 게이트 (verdict=PASS 검증) |

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
| `PASS` | 모든 영역(BE/FE) `log_task_state.status='SUCCESS'` | Orchestrator Phase 5 ② |
| `FAIL` | Stage 3 실패 또는 `retry_count >= 3` | Orchestrator Phase 5 ③, ④ |
| `ERROR` | 어느 Agent의 `log_agent_runs.status='FAILED'` (예외 발생) | Orchestrator Phase 5 ① |

종료 우선순위: ERROR > PASS > FAIL(STAGE3) > FAIL(retry 초과) > 다음 라운드.

## 절대 규칙 (위반 금지)

1. **폴더 격리** — BE Agent는 `BE/`만, FE Agent는 `FE/`만 수정. `validatePaths` 런타임 검증.
2. **보호 파일** (`stack.config.json` `protectedConfigFiles`) — Agent는 `package.json`, `vite.config.js`, `index.html`, `.eslintrc.json` 등을 절대 작성 못함. `validatePaths`가 차단.
3. **새 의존성 금지** — `allowedDeps`만 사용. 부족하면 `notes`에 사유만 적고 코드 만들지 말 것. 매니페스트 수정 금지.
4. **Placeholder 보존** (Convention §9) — bootstrap이 깐 `server.test.js`/`App.test.jsx`는 그대로 유지. 새 코드가 거기에 맞춰야 함.
5. **dotenv override** — 모든 `dotenv.config()` 는 `{ override: true }`.
6. **Stage 3 (테스트) 실패 = 즉시 FAIL** — 재시도 없음. Stage 1/2 실패만 최대 3회 재시도.
7. **main push 게이트** — pre-push hook이 최신 verdict=PASS 인지 검사. 우회: `git push --no-verify` (문서만 수정한 경우에 한해서).

## 사람·Claude 직접 편집 vs Agent 자동 생성

위 절대 규칙 #1, #2의 `validatePaths` 검증은 **LLM Agent가 코드를 응답으로 내놓을 때** 적용된다. 사람이 IDE로 직접 편집하거나, Claude(어시스턴트)가 Edit/Write 도구로 BE/, FE/, 또는 protected 파일을 수정하는 것은 **정상적인 개발 작업으로 허용**된다.

- Agent 산출물 → `validatePaths` 통과해야 디스크에 반영
- 사람·Claude 직접 편집 → 자유. 단, push 시점에 pre-push gate가 최신 orchestrator verdict는 확인함.

직접 코드를 손본 뒤에 시스템에 반영하려면 결국 orchestrator를 다시 통과(verdict=PASS)시켜야 main에 push 가능.

## 표준 명령

```bash
# DB 초기화
npm run init-db

# 파이프라인 실행
npm start                                          # 기본 시나리오 (회원가입)
node agents/orchestrator.js "기능 요청 자연어..."   # 커스텀

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
2. PASS면 단위별로 commit, 그 다음 push.
3. pre-push hook이 자동으로 verdict=PASS 확인.

### 실패한 실행 진단
1. 콘솔의 `task_id` 확인.
2. `log_agent_runs WHERE task_id=...` 조회 → 어느 Agent가 실패했는지.
3. LLM JSON 깨졌으면 raw 응답이 `os.tmpdir()/llm-bad-response-*.txt`에 덤프됨.
4. `log_task_state`의 `failed_stage`, `fix_instructions`, `stage_logs` 확인.

### 스택 교체
README의 "스택 변경 체크리스트" 섹션 참조.

## 컨벤션

- `rules/code_convention.md` — BE/FE Agent가 매 LLM 호출 시 읽음. 명명 규칙, 보안(bcrypt, prepared statement), API 응답 형식, placeholder 보존, 스택 일관성 포함.
- API 응답 형식: 모든 엔드포인트가 `{ success: bool, data: any, error?: string }` 따름.

## 최근 결정 (타임라인)

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
