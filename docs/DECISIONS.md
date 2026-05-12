# Decision Log

시간순 결정 기록. 최근 3개는 [CLAUDE.md](../CLAUDE.md)에도 미러.

## 2026-05-14 — D33 BE Agent migration emit + 자동 적용 (B-2 도입 결정)

**배경**: D31에서 *학생 데모 안전성* 위해 "in-memory 우회 + emit 금지" 임시 조치. D32(`db/*.sql` 자동 순회)로 *기반*이 마련됨. D33은 *Agent가 만든 migration .sql을 시스템이 자동 적용*해 D31에서 미루었던 "비즈니스 schema 자동 적용 메커니즘"을 완전 흡수.

**결정 — B-2 방식**:
- BE Agent가 `BE/db/migrations/<timestamp>_<name>.sql` 형태로 새 schema 변경을 emit
- orchestrator가 새 migration을 감지해 *MySQL에 자동 실행* + *이력 테이블에 적용 기록*
- 이력 테이블(`log_db_migrations` 가칭)로 *중복 적용 방지* + *어느 task가 어느 migration을 만들었는지 추적*

**D31의 어느 조항이 폐기되나**:
- ❌ "CREATE TABLE SQL emit 금지" — *폐기*
- ❌ "BE/db/*.sql 파일 emit 금지" — *폐기* (단 경로는 `BE/db/migrations/` 하위로 표준화)
- ❌ "in-memory/stateless 우회" — *선택지로 격하* (영속화 vs in-memory 둘 다 OK)
- ✅ "agent_schema 분리 (log_*)" — *유지*
- ✅ "app_users 영구 삭제" — *유지* (필요 시 Agent가 migration으로 재생성)
- 🔄 "ALTER/CREATE/DROP 가이드 금지" — *완화* (Agent가 직접 SQL 작성, 시스템이 적용)

**적용 범위 (D32와의 분리)**:
- `db/*.sql` (메인) — *사람·시스템이 정의한 base schema*. agent_schema.sql + (선택) business_schema.sql. reset/init 시 자동 순회 (D32).
- `BE/db/migrations/*.sql` (Agent emit) — *cycle별 schema 변경*. orchestrator가 각 cycle 직후 적용. 중복 방지 메커니즘 필수.

**구현 진척 (B-2)**:
- 본 결정문은 *방향 확정*. 코드 변경은 후속 commit.
- `rules/be.md` §4 / `agents/codechecker_agent.js` / `agents/be_agent.js`의 system prompt는 *B-2 구현 commit과 함께* 갈아엎음. 그 전까지 D31 prompt 유지 — **런타임 안전 보장** (지금 prompt만 풀면 Agent emit이 적용 안 되어 D31 이전 사고 재발).
- 본 commit은 *문서·메모리 갱신*만. 사용자·미래 세션이 *방향*을 인지할 수 있도록.

**비-영향**:
- agent_schema(`log_*`) 분리 — 그대로
- reset.sql 동적 DROP + db/*.sql 순회 — D32 그대로 유효 (D33과 자연 결합)
- `app_users` 영구 삭제 — 그대로

## 2026-05-14 — D32 reset.sql 동적 DROP + db/*.sql 자동 순회

**배경**: D31(`agent_schema.sql` 분리)이 "비즈니스 schema 자동 적용 메커니즘은 향후 별도 작업"으로 남겨둠. D32가 그 후속 — 비즈니스 schema 파일을 `db/business_schema.sql` 등으로 추가하기만 하면 reset 흐름에 자동 포함되도록 *기반 메커니즘* 도입.

**변경**:
- `db/reset.sql` 내용 전체 교체. *log_* 명시 DROP*에서 *information_schema 기반 동적 DROP*으로:
  ```sql
  SET @tables = (SELECT GROUP_CONCAT('`', table_name, '`')
                 FROM information_schema.tables
                 WHERE table_schema = 'myfirstagentapp_db');
  SET @sql = IFNULL(CONCAT('DROP TABLE IF EXISTS ', @tables), 'SELECT 1');
  PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  ```
  빈 DB일 때 `@tables`가 NULL이 되어 PREPARE가 실패하는 케이스를 `IFNULL`로 우회.
- `lib/reset_db.js`, `ui/routes/init.js`, `ui/routes/git.js#resetDatabase` 세 곳:
  *agent_schema.sql 단일 실행* → *db/\*.sql 알파벳 순서로 순회 실행* (reset.sql 자기 자신은 제외). 코드 변경 없이 새 schema 파일 추가만으로 적용.

**Why**: 사용자 명시 요구 — "reset.sql: myfirstagentapp_db 안의 모든 테이블 삭제로 수정 / reset.sql 실행 후 main 안의 myFirstAgentApp\db의 모든 sql 실행". D31 단계에서 명시한 "향후 작업"을 이번에 흡수.

**비-영향**:
- `db/agent_schema.sql` 자체는 변경 없음 (여전히 자동 적용)
- 동작 결과: 현재 `db/` 안에 `agent_schema.sql` + `reset.sql` 둘만 있어 *기존 D31 흐름과 출력 동일* — 단 *확장성*이 가치 (새 schema 파일 추가만으로 적용)
- 4번째 reset-db 호출자(`ui/routes/deploy.js POST /api/reset-db`)는 `lib/reset_db.js`를 child로 spawn해서 변경 자동 흡수

**잠재 위험·완화**:
- 사용자가 수동으로 만든 *시스템 외 테이블*도 함께 삭제됨 → 사용자 의도와 일치 ("모든 테이블")
- `db/*.sql` 순서 의존성 (FK) → 알파벳 정렬. 사용자가 `01_*.sql` prefix로 순서 제어 가능
- 4곳 중복(reset_db.js / init.js / git.js / reset.sql 자체) → 후속 refactor에서 공통 helper로 통합 권장 (이번 변경은 *동작 일치* 우선)

**작업 흐름 변경**: 메모리 `feedback_check_git_status.md` rule 2026-05-13 정정에 따라 *PR 없이 claude/test에 직접 commit + `git push origin claude/test:main` ff push*. 이 D32가 새 흐름의 *첫 사례*.

## 2026-05-13 — D31 schema.sql 분리 + 비즈니스 schema 폐기

**문제**: 단일 `db/schema.sql` 안에 Agent 도구 테이블(`log_*`)과 비즈니스 테이블(`app_users`)이 혼재. BE Agent가 schema 확장 요청(e.g. "게임 도메인 추가")을 받으면 `BE/db/schema_game.sql` 같은 파일을 *emit*하지만 시스템에 그 SQL을 *실제 MySQL에 실행하는 메커니즘이 0건* (`agents/be_agent.js`는 `schema.sql`을 read만, `orchestrator.js`/`bootstrap.js`/`init_db.js` 어디서도 `BE/db/*.sql`을 적용하지 않음). 결과: 파일은 디스크에 있는데 DB는 옛 상태 → 런타임 `ER_NO_SUCH_TABLE` 500. 실제 발생: `task_20260512082949_4c3135`.

**D31 결정**:
- **Q1 = 폐기** — `app_users` 영구 삭제. 비즈니스 schema 자동 적용 메커니즘은 별도 작업(scope 미정).
- **Q2 = a (DROP + CREATE)** — reset-db 흐름. "재실행" 시맨틱에 부합, 컬럼 추가 등 schema 변경도 reset 한 번으로 반영. TRUNCATE보다 일관성 우선.
- **Q3 = 정리** — 직전 cycle 잔재(BE/src + FE/src) 통째 baseline 복원. Q1=폐기로 회원가입 코드 전체가 schema와 inconsistent해지므로 BE+FE를 bootstrap placeholder 상태로 되돌림.

### 코드 변경

- `db/schema.sql` → `db/agent_schema.sql` rename + `app_users` 정의 제거. 헤더 코멘트에 "Agent 도구 전용, 비즈니스 schema는 향후 별도 메커니즘"으로 명시.
- `db/reset.sql` → `TRUNCATE` → `DROP TABLE log_*` (FK 의존 순서). agent_schema 재실행은 application code(`lib/reset_db.js`, `ui/routes/init.js`)가 담당.
- `lib/init_db.js`, `lib/reset_db.js`, `lib/db.js` — 경로/주석 갱신. `reset_db.js`는 DROP 후 agent_schema.sql 재실행하도록 2단계 흐름.
- `agents/codechecker_agent.js`, `agents/be_agent.js` — schema 주입 경로 + LLM 가이드 강화: "비즈니스 DB 테이블은 현재 시스템에 없다. in-memory/stateless로 우회, `CREATE TABLE` SQL emit 금지, `BE/db/*.sql` 파일 emit 금지".
- `ui/routes/init.js` — `DB_TABLES`에서 `app_users` 제거 + reset 로직에 agent_schema.sql 재실행 추가.
- `ui/public/index.html` — reset-db 확인 메시지 "truncate" → "DROP+CREATE".

### Rules / 문서 변경

- `rules/be.md` §4 — "비즈니스 DB 영속화 요구사항이 들어오면 in-memory/stateless로 우회" 정책 명문화. `CREATE TABLE` / `BE/db/*.sql` emit 금지 명시.
- `rules/common.md` §2 — `app_users` 예시를 generic `some_table`로 교체.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/MIGRATION.md`, `docs/ROADMAP.md` — schema.sql 경로 + DB 테이블 목록 갱신. MIGRATION 검증 step은 회원가입 → `/health` smoke로 교체.

### 무엇이 *해결되지 않는가*

- BE Agent의 *비즈니스 schema 자동 적용 메커니즘*은 여전히 없음. 향후 작업으로 남김.
- 다음 cycle에서 사용자가 회원가입 같은 비즈니스 DB 영속화를 요구하면 BE Agent는 in-memory로만 처리 (재시작 시 데이터 소실). 학생 PoC scope에선 허용 가능.

### 영향 받지 않는 부분

- Phase 4 lint/test 흐름, Phase 8/9 deploy/posttest 흐름, contract split layout, COMMIT_MODE/VALIDATION_MODE/DEPLOY_MODE 토글, Phase 5 verdict 평가 — 모두 그대로.

## 2026-05-12 — D30 Stage 3 retry 허용 + rules 강화

**문제**: 이전 정책(Stage 3 fail → 즉시 FAIL, retry 없음)이 LLM의 흔한 안티패턴
(예: Modal의 `if (!isOpen) return null`)에서 자동 회복을 막음. 실제 task_id
`task_20260512055149_aa026f`에서 Modal smoke test가 `expected null not to be
null`로 FAIL — 비즈니스 코드 한 줄만 고치면 통과할 수 있는데 cycle 전체가
FAIL로 끝남.

근본 원인 — rules/fe.md §6에 "smoke test 친화적으로" 가이드만 있고 *구체적
안티패턴(null 반환) 명시*가 없었음. LLM이 React 관용 패턴(`if (!isOpen) return
null`)을 자연스럽게 emit. + Stage 3가 retry 못 받아 회복 기회 없음.

**D30 = A 결정 — Stage 3도 retry 대상 + rules에 명시적 안티패턴 추가**

### 코드 변경

- `agents/lint_agent.js`:
  - `buildFixInstructions`에 STAGE3 case 추가. fix_instructions에 vitest/jest 출력 그대로 전달 + 흔한 안티패턴 4종 안내(조건부 null 반환 / default prop 누락 / export 누락 / import 오타).
  - Stage 3 fail 시 `retry_count++` + `fix_instructions` 채움 (이전엔 둘 다 안 함).
- `agents/orchestrator.js` Phase 5 evaluator:
  - "③ STAGE3 즉시 FAIL" 분기 제거. Stage 1/2/3 모두 `retry_count >= MAX_RETRIES`(3) 도달 시에만 FAIL.
  - MAX 초과 시 reason 메시지에 *retry 시도 후 끝까지 통과 못 함*을 명시.

### Rules 강화

- `rules/fe.md §4-bis (NEW)` — "조건부 `return null` 절대 금지". Modal/Toast 같은
  컴포넌트의 닫힌 상태는 `<div hidden />` 또는 `display: none`로. 좋은/나쁜 예시
  코드 + 시스템 smoke test가 props 없이 `render(<Component />)` 호출함을 명시.
- `rules/be.md §7-bis (NEW)` — 모듈 top-level throw 금지. 환경변수 검증은
  *핸들러 호출 시점*에. require 시 어떤 prop 없이도 module이 load되어야 함.

### Trade-off

| 항목 | 이전 (Stage 3 즉시 FAIL) | D30 (retry 허용) |
|---|---|---|
| LLM 회복 기회 | 0 | 최대 3회 |
| LLM 토큰 비용 | 적음 | retry당 LLM 한 번 더 호출 |
| 잘못된 코드 위험 | 0 (cycle 자체 FAIL) | LLM이 test 통과만 위해 의미 잘못된 코드 emit 위험 (rules 강화로 완화) |
| 결정론성 | 강함 | retry 횟수에 따라 결과 다를 수 있음 |

추가 위험 완화: smoke test 자체가 단순(render만 / typeof check)이라 LLM이
*비즈니스 의도를 보존하면서* 룰 따라 수정하는 게 가장 자연스러운 path.
복잡한 비즈니스 test는 시스템이 자동 생성 안 함.

### 검증

- 단위 테스트 (`tests/orchestrator_util.test.js`, `tests/lint_agent.test.js` 있다면) 통과 확인
- 실제 cycle에서 Modal-style 안티패턴이 retry로 회복되는지 — 다음 실제 cycle에서 관찰

---

## 2026-05-12 — D29 단일 host MySQL 통합 (mysql 컨테이너 폐지)

**문제**: 현재 디자인은 도구/비즈니스 *이중 DB*. host MySQL은 agent 로그용(`log_*`), 컨테이너 MySQL은 비즈니스용(`app_users`, ephemeral). 사용자가 HeidiSQL 같은 GUI에서 `app_users`를 못 찾는 혼란이 반복 발생하고, 컨테이너 재배포마다 비즈니스 데이터가 사라져 dogfood가 불편.

`lib/db.js`의 주석 "Used by all agents + orchestrator for log_* tables and by BE runtime for app_users"가 가리키듯 *원래 의도가 단일 DB*였고, 컨테이너 MySQL은 PoC 격리를 위한 우회였음. `schema.sql`도 이미 단일 DB로 정의돼있어 schema 변경 0.

**D29 = A 결정 (single host MySQL, BE 컨테이너는 `host.docker.internal`로 연결)**

근거 — DX, 단일 source of truth, EC2/RDS prod 패턴 일치, 컨테이너 단순화, schema 단일화. 격리는 `npm run reset-db`로 수동.

**Obsoleted by D29**:
- D9=C (ephemeral mysql volume + schema.sql init mount)
- D14=B (mysql healthcheck + service_healthy gate)
- D16=A (container env hardcoded; host .env not propagated) — BE env는 이제 host `.env`에서 `${var}` 보간
- D18=A (image: mysql:8)

**변경 파일**:
- `lib/stack_templates/docker-compose.yml` — `mysql` 서비스 통째 제거. `be:`의 env가 `host.docker.internal` + host `.env` 보간 (`${DB_PASSWORD}` 등). `extra_hosts: ["host.docker.internal:host-gateway"]` (Linux 호환).
- `agents/deploy_agent.js` — `SERVICES`/`PORT_ENV_KEY`에서 mysql 제거, `getPorts` 갱신, `resolvePortsWithFallback` 갱신. 신규: `pingHostMysql()` — 부팅 전 호스트 MySQL TCP probe로 fail-fast.
- `.env` / `.env.example` — `DEPLOY_PORT_DB` 제거. DB 블록 주석에 "BE 컨테이너도 이 값 사용" 명시.
- `rules/be.md` §4 — 단일 DB 가정 + `app_users` 영구 보존 명시.
- (UI 정리 — 같은 commit) `ui/routes/deploy.js`, `ui/public/index.html`의 `ports.mysql` 표시 제거.

**격리 정책**: (α) 수동 — 사용자가 `npm run reset-db` 또는 UI의 `⟲ reset-db` 버튼으로 명시적 정리. 자동 truncate는 의도치 않은 비즈니스 데이터 손실 위험으로 도입 안 함.

**검증**: 호스트 MySQL에 회원가입 데이터가 영구 보존되는지 + HeidiSQL에서 `localhost:3306` 한 세션으로 *모든 데이터* 조회 가능한지.

**EC2 마이그레이션 영향**: `.env`의 `DB_HOST=<RDS endpoint>` 한 줄만 변경하면 BE 컨테이너도 자동으로 그 RDS 사용 (single source of truth 확보).

---

## 2026-05-11 — UI control panel (npm run ui)

ROADMAP의 2순위 "UI (+Observability)" 항목 진입 후 완료. Express + 정적 HTML 추천(ROADMAP 명시) 그대로 채택 — Vite+React가 외관 좋지만 ~200 LOC 약속 지키려면 Express가 적절.

**디자인 결정**:
- **새 abstraction 안 만들고 기존 위에 얹음** — UI는 DB(`log_agent_runs`/`log_agent_decisions`/`log_task_state`) + `.env`의 얇은 GUI viewer/spawner. orchestrator·agents 코드 무변경.
- **포트**: `UI_PORT=4000` (`.env`+`.env.example`에 신규). deploy_agent와 동일한 `net.createServer` probe로 충돌 시 +1..+20 자동 fallback.
- **시작 명령**: `npm run ui` (foreground). orchestrator는 별도 (`npm start`)이라 두 prompt가 따로 떠도 됨.
- **동시 실행 정책**: in-memory 단일 slot. UI에서 Run 누른 상태에 두 번째 누르면 409 응답 + 브라우저는 "busy" 표시.
- **모드 토글 처리**: `.env` 직접 atomic 갱신 — ".env가 single source of truth, UI는 그것의 GUI editor" 결정(2026-05-08) 그대로. `lib/env_writer.js`가 temp file → rename atomic write 패턴, CRLF/주석/순서 보존.
- **Security**: `UI_EDITABLE_KEYS` 화이트리스트 (16개 토글)만 PUT 허용. `ANTHROPIC_API_KEY`·`DB_PASSWORD`·`UI_PORT` 등은 UI에서 안 보이고 갱신도 못 함. PUT body에 화이트리스트 외 키 있으면 400.
- **Polling**: 브라우저가 1.5초마다 `/api/tasks` + `/api/run` polling. SSE/WebSocket 없음 — ROADMAP의 단순 안 그대로.

**구현**:
- `lib/env_writer.js` (140 LOC) — `readEnv` + `updateEnv` + `UI_EDITABLE_KEYS`. `updateEnv`는 정확히 한 trailing newline 보장 + CRLF 보존 + missing key는 blank line 뒤에 append + tmp/rename atomic.
- `ui/server.js` (190 LOC) — Express. 7 endpoint: `GET/PUT /api/env`, `GET /api/tasks`, `GET /api/tasks/:task_id`, `GET /api/tasks/:task_id/contract` (`normalizeContract`로 expand), `GET/POST /api/run`, `POST /api/reset-db`. `child_process.spawn`으로 orchestrator/reset-db 호출 — stdout 30KB tail 보존 + `task_id=...` regex 추출.
- `ui/public/index.html` (220 LOC) — 단일 페이지 + 인라인 CSS/JS. dark theme. 왼쪽 패널(prompt 입력 + 토글 16개 GUI editor + reset-db) / 오른쪽 패널(최근 20 task 테이블 + 선택 시 decision/states/runs 타임라인).
- `tests/env_writer.test.js` 12 케이스 — read, in-place update, append, mixed, CRLF, number/boolean coercion, atomic (`.tmp` 누수 없음), missing file 생성, 화이트리스트 frozen.
- `.env` + `.env.example` 갱신 — `UI_PORT=4000`.
- `package.json` — `"ui": "node ui/server.js"` script + `express: ^4.21.0` dependency.

**검증**:
- `npm test` 122/122 (110 prior + 12 new).
- Smoke (`npm run ui`):
  - `[ui] listening on http://localhost:4000`
  - `GET /api/env` → 16 editable keys + 현재 값 정상
  - `GET /api/tasks` → 직전 `task_20260511074027_33a2e1` (PASS) 정상 응답
  - 종료 정상.

**ROADMAP에 명시된 [E] 단계 후 BE_AGENT_MODE 토글**: `UI_EDITABLE_KEYS`에 추가만 하면 UI에서 즉시 토글 가능. [E] 완성 시 한 줄 추가로 마무리.

## 2026-05-11 — API contract split layout (index + router/)

`shared/api_contract.json` 한 파일에 모든 endpoint detail이 몰려있던 구조를 둘로 분리:
- `shared/api_contract.json` — index (`{ version, base_url, endpoints: [{name, path, method, description}] }`)
- `shared/router/<name>.json` — 개별 endpoint full detail (`{ path, method, description?, request, responses }`)

**Why**: endpoint가 많아지면 한 파일이 빠르게 커지고 변경 영향 추적이 어려움. 각 endpoint를 한 파일로 분리하면 디스크에서 한눈에 어떤 API가 정의돼 있는지 보임 + LLM이 한 endpoint 단위로 수정할 때 컨텍스트도 좁아짐.

**구현**:
- `lib/api_test.js`: `normalizeContract(contract, { routerDir })` — `endpoint.name`이 있고 `request`/`responses`/`response`가 없으면 index entry로 판정 → `routerDir/<name>.json` 로드해서 inline. 기존 base_url 결합 + legacy `response.{success, error_cases}` 매핑 로직은 그대로 유지 (3 dialect 지원). `runContract()`는 contract 파일과 같은 디렉터리의 `router/`를 default routerDir로 사용.
- `agents/codechecker_agent.js`: SYSTEM_PROMPT의 contract format 섹션을 split 형식으로 바꾸고, LLM 응답 schema에 `router_details` 필드 추가. `run()`이 (1) index ↔ details 매칭 검증 (orphan/missing 양방향 throw), (2) `shared/api_contract.json` 작성, (3) `shared/router/` mkdir + 새 detail file write + stale file unlink. CodeChecker output의 `api_contract`는 in-memory에서 `normalizeContract`로 expand한 full form (BE/FE Agent로 그대로 전달돼 prompt에 inject).
- `agents/be_agent.js`, `agents/fe_agent.js`: `readApiContractIfAny()`가 `normalizeContract`를 호출하도록 갱신. retry 라운드·standalone 실행에서도 같은 full form을 본다.
- `tests/api_test.test.js`: split layout 6 케이스 추가 (index expansion / base_url 결합 / detail 안의 legacy response shape / 누락 router file throw / routerDir 생략 시 legacy path / 이미 full인 endpoint 재expansion 안 함).
- 마이그레이션: 기존 main의 `shared/api_contract.json`을 두 파일로 분리 — 사용자가 추가 손질 (description, schema 정밀화).

**검증**: 새 사이클(`task_20260511074027_33a2e1`, VALIDATION_MODE=on) 풀 통과 — Phase 5 verdict=PASS · Phase 8 Deploy `up complete in 17073ms` · Phase 9 PostTest `PASS: 1/1 endpoints (65ms)` (이전 사이클 150ms 대비 빠름, 더 작은 detail file 로드 영향). `npm test` 110/110.

## 2026-05-11 — First full-cycle hardening sweep

[A] Phase 8/9 commit(`89740ca`) 이후 **end-to-end로 실제 풀 사이클을 처음 돌려본** 작업. main에 잔존하던 옛 LLM 산출물 + LLM 응답의 stochastic 결함이 줄줄이 드러나 한 commit씩 잡아냈고, 최종 사이클(VALIDATION_MODE=off 모드, task `task_20260511070429_2b5606`)에서 `[PASS]` + Phase 9 `PASS: 1/1 endpoints (150ms)` 달성. 누적 8 robustness layer (이전 7 + Continuation).

순서대로:

- **`40c0675` chore(reset): remove tracked BE/ FE/ artifacts** — main에 commit돼 있던 ~40개 BE/, FE/ 파일은 옛 LLM 사이클이 만든 stale baseline. `bootstrap.copyFileIfMissing` 정책상 새 워크트리에 stack_templates 새 버전이 안 깔리는 원인. 통째 삭제. 다음 사이클부터 fresh.
- **`dc5253a` feat(guards): validateAllowedDeps + FE eslint jest globals** — LLM이 `email-validator` 같은 미허가 dep를 require해서 Stage 3에서 모듈 못 찾고 fail. `lib/prompt_util.js`에 require()/import 정적 분석 가드 추가 (Node builtin은 module.isBuiltin로 화이트리스트). 위반 시 `UNAUTHORIZED_DEPS` throw → 라운드 ERROR (즉시 fail-fast, fix_instructions retry 안 함). FE 측에선 `lib/stack.config.json` `eslintConfig.env.jest=true` + `globals.vi="readonly"` 추가 — test_codegen이 자동 생성한 smoke test의 `describe/it/expect/vi`가 eslint `no-undef`로 막히던 fail. `rules/{common,be,fe}.md`에 흔한 위반 카테고리 6종(검증 라이브러리 / HTTP 클라이언트 / UUID / lodash·moment / styling / JWT) 명시. unit test 12 추가.
- **`fe63c89` feat(deploy): port preflight + auto-fallback (OS layer)** — `.env`의 `DEPLOY_PORT_DB=3306`이 호스트 MySQL과 충돌해 compose up exit 1. `agents/deploy_agent.js`에 `isPortFree(port)` (`net.createServer().listen` probe) + `findFreePort(start, label, max=20)` + `resolvePortsWithFallback()` 추가. 충돌 시 `+1..+20` walk로 첫 빈 포트 선택 후 `process.env.DEPLOY_PORT_{DB,BE,FE}` mutate → compose substitution + Phase 9 baseUrl이 같은 새 값 공유. 컨테이너 *내부* 포트는 그대로 (호스트 매핑만 바뀜). unit test 7 추가.
- **`d95f901` fix(phase-9): contract format strictness + normalizer w/ base_url + legacy** — Phase 9가 `unexpected status 404 (declared statuses: none)`로 fail. 원인 두 개: (1) CodeChecker가 `response.{success, error_cases}` legacy shape으로 emit, `lib/api_test.js`는 `responses.{<code>}` 기대. (2) contract의 `base_url: "/api/v1"`이 fetch URL 생성 시 무시돼 404. fix: CodeChecker system prompt에 canonical format 명세 + 금지 형식 예시. `lib/api_test.js`에 `normalizeContract()` 추가 — legacy `response.success`/`error_cases` → `responses.{<code>}` 변환 + `base_url` prefix를 endpoint.path에 합침 (idempotent). unit test 17 추가.
- **`db8a5c5` feat(llm): Continuation pattern in callJSON** — 사용자 결정으로 "마지막에 반드시 적용" (현재 truncation 빈도 0이지만 8번째 layer로 보험). `stop_reason='max_tokens'`일 때 throw 대신 부분 응답을 assistant message로 누적 + "이어서 계속" user message로 재호출. `MAX_CONTINUATIONS=3` 후 여전히 잘려있으면 기존 whole-call retry layer(`MAX_LLM_RETRIES=2`)로 fallback. `_client` opt-in 인자로 stub 주입 가능 — unit test 8 추가 (stub Anthropic client로 누적/종료/cache 보존 검증).
- **`732e237` fix(deploy): port preflight also consults docker ps** — OS net layer만으로는 부족했음. Windows Docker Desktop quirk: 이전 FAIL 사이클의 stale 컨테이너(D6=B 정책으로 보존됨)가 host 포트 점유 중이어도 Node net.listen이 free라고 응답해 fallback이 그 포트로 가서 compose가 again fail. 2-layer 추가: `dockerPublishedPorts()` (`docker ps --format '{{.Ports}}'` 파싱 → Set<number>). `findFreePort`에 dockerPorts arg 추가 — 후보 포트를 docker Set과 먼저 비교, 다음에 OS probe. Docker CLI 부재 시 빈 Set 반환으로 graceful degrade. unit test 3 추가.
- **`b670962` docs(operations): document the 2-layer port preflight** — OPERATIONS.md "포트 충돌 시" 섹션 2-layer 검출 명시.
- **`6cba494` feat(schema): inject db/schema.sql into CodeChecker + BE Agent prompts** — Phase 9가 LLM 코드의 `SELECT ... FROM users` 때문에 `Table 'myfirstagentapp_db.users' doesn't exist`로 500 → fail. schema는 `app_users`. CodeChecker + BE Agent system prompt에 `db/schema.sql` 전체를 dynamic inject + 규칙 (BE 비즈니스는 `app_users`만, `log_*`는 agent system 전용, contract example은 schema 타입과 일치, INSERT 시 AUTO_INCREMENT/DEFAULT 컬럼 제외, password 컬럼명은 `password_hash`). `cache: 'system'` 덕분에 매 호출 재전송 안 됨 — input utilization 7~12% 유지. `rules/be.md §4`도 schema-driven bullet으로 강화.
- **`f02ebdf` docs(operations): single reusable test worktree policy** — 이번 세션 동안 `verify-clean`/`verify-port-fix`/`finalize`/`deploy-check` 워크트리를 매 fix마다 새로 만들어 디스크·docker container·npm install이 누적. 정책 변경: `.claude/worktrees/test/` (branch `claude/test`) 한 번 만들고 재사용. 사이 정리는 `rm -rf BE FE` (bootstrap fresh 깔림, node_modules 보존). 정책을 OPERATIONS.md에 박아 향후 세션에도 적용.

**최종 검증 사이클** (task `task_20260511070429_2b5606`, VALIDATION_MODE=off):
- 1 라운드 PASS · LLM 호출 정확히 3회 · port preflight 3-fallback (3306→3309 / 3001→3003 / 5173→5175 — finalize+verify-port-fix stale 컨테이너들이 3307~3308 점유 중인 환경에서) · Deploy up 52186ms · PostTest 1/1 endpoints 150ms · Phase 7 auto-commit · Phase 7.5 teardown.

`npm test`: 104/104 PASS (이전 57 + 이번 47 새 케이스).

## 2026-05-08

- **89740ca**  [A] Phase 8/9 — **S8 (orchestrator integration + DB schema migration) sub-decision D38 잠금 + 코드 적용**.
  - **D38 = A** — DB 마이그레이션 방식: `db/schema.sql` 직접 수정 + 기존 DB가 있는 사용자에게 ALTER 1줄 안내. PoC 사용자 1명 환경 + 가장 단순. README/OPERATIONS에 ALTER 명령 추가 (S9에서 처리).
  - **자동 사항 (D39, D40, D41) 그대로 적용**:
    - **D39 (Phase 8/9 호출 위치)**: `main()` try 블록 안, round loop 종료 후 (finalVerdict가 결정된 시점). round loop 종료 시 finalVerdict가 PASS이면 Phase 8 호출, Phase 8이 SUCCESS이면 Phase 9 호출. FAIL/ERROR면 Phase 8/9 자체를 skip.
    - **D40 (verdict 평가 함수)**: 새 함수 `evaluateFinalVerdict({ initialVerdict, deployStatus, posttestStatus })` 추가. 기존 `evaluateVerdict()`는 그대로 보존. 규칙: initialVerdict가 PASS 아니면 그대로 / deployStatus가 FAILED면 FAIL / posttestStatus가 FAILED면 FAIL / 모두 SUCCESS면 PASS.
    - **D41 (teardown 호출 시점)**: Phase 7(auto-commit) 직후 Phase 7.5 신규 단계. final verdict가 PASS이고 DEPLOY_MODE=on일 때만 `deployAgent.teardown()` 호출. db.close()는 finalize에서 이미 호출됐지만 teardown은 docker-only라 무관.
  - **변경 파일**:
    - `db/schema.sql`: `log_agent_runs.agent_name` ENUM에 `'Deploy'`, `'PostTest'` 두 값 추가.
    - `agents/orchestrator.js`: require 추가(deploy_agent, test_agent), `evaluateFinalVerdict` 함수 추가, main()에 Phase 8/9 호출 블록 추가, Phase 7 다음 teardown 호출 추가.
  - **기존 DB 사용자 마이그레이션 안내** (S9 README/OPERATIONS에 추가 예정): `ALTER TABLE log_agent_runs MODIFY agent_name ENUM('Orchestrator','CodeChecker','FE','BE','Lint','Deploy','PostTest') NOT NULL;`
- **89740ca**  [A] Phase 8/9 — **S7 (test_agent.js sub-decision D37 잠금 + 자동 사항 7개) + `agents/test_agent.js` 작성**.
  - **D37 = A** — PostTest timeout: env `POSTTEST_TIMEOUT_SEC` (기본 60초) 추가. **누적 신규 env 7개** (S9에서 `.env`/`.env.example` 동기 갱신 예정): `DEPLOY_PORT_FE`, `DEPLOY_PORT_BE`, `DEPLOY_PORT_DB`, `DEPLOY_MODE`, `LOG_TAIL_LINES`, `DEPLOY_TIMEOUT_SEC`, `POSTTEST_TIMEOUT_SEC`.
  - **자동 사항 7개 그대로 적용**:
    1. 함수 시그니처: `module.exports = { run }` (deploy_agent 일관).
    2. `DEPLOY_MODE=off` 처리: SUCCESS + `{ skipped: 'DEPLOY_MODE=off' }` (D26=A 패턴).
    3. baseUrl = `http://localhost:${DEPLOY_PORT_BE || 3001}` (호스트의 expose port로 접근).
    4. `agent_name='PostTest'` (S8에서 ENUM 추가 예정).
    5. output_json: PASS 시 가벼운 summary `{ pass, total, passed, duration_ms, baseUrl }`. FAIL 시 + `results` (per-endpoint detail) — D31=C 정신 일관.
    6. timeout 구현: `Promise.race` (api_test가 fetch 기반 비동기라 `spawnSync`의 timeout 못 씀).
    7. error 분류: timeout → FAILED + error msg / runContract.pass===false → FAILED + per-endpoint detail / 예외 → FAILED + error msg.
  - **schema 의존성**: `log_agent_runs.agent_name` ENUM에 `'PostTest'` 추가 필요 (S8 schema migration에서 'Deploy'와 함께 처리).
- **89740ca**  [A] Phase 8/9 — **S6 라운드 1 (lib/api_test.js sub-decision D33~D36) 잠금 + `lib/api_test.js` 작성**.
  - **D33 = A** — HTTP client: Node 18+ 내장 `fetch` (의존성 0). package.json `engines.node: ">=18"`이 보장 조건.
  - **D34 = B** — JSON Schema validator: 직접 작성한 simple validator (~80줄). 의존성 0 + 학생 시연 시 schema 검증 동작 원리를 코드로 직접 보여줄 수 있는 교육 가치. `api_contract.json`의 feature 범위(type, required, properties, const, format='email', minLength, maxLength)만 지원하는 minimal 구현.
  - **D35 = A** — test 데이터: `api_contract.json`의 `request.schema.properties.<field>.example`을 그대로 사용. D9=C(ephemeral DB) 시너지로 매 task fresh DB → 같은 example 사용해도 idempotency 문제 없음.
  - **D36 = A** — endpoint 호출 순서: sequential (`contract.endpoints` 정의 순서). 자연스러운 의존성(예: signup → login) 표현 가능.
  - **검증 통과 기준 (D4 정신 구체화)**: response의 status code가 contract의 `responses` 키 중 하나이고, 그 status의 schema에 응답 shape이 일치하면 PASS. "200 필수" 아님 — 401도 contract에 declared 되어있고 schema 통과면 PASS. "endpoint가 declared response 형태로 정상 작동"하는지 검증.
  - **module exports**: `loadContract`, `validate`, `exampleBodyFromSchema`, `runEndpoint`, `runContract`. S7의 test_agent.js가 `runContract({ baseUrl })`만 호출하면 됨.
- **89740ca**  [A] Phase 8/9 — **S5 라운드 2 (deploy_agent.js 내부 구현 sub-decision D28~D32) 잠금 + `agents/deploy_agent.js` 작성**.
  - **D30 = C** — timeout: env `DEPLOY_TIMEOUT_SEC` (기본 300초). 학생 환경 변동성 친화. 누적 신규 env 6개 (S9에서 .env/.env.example 동기 갱신).
  - **D31 = C** — output_json 구조: PASS 시 `{ exit_code: 0, duration_ms, services: {mysql:'healthy', be:'running', fe:'running'}, ports }` (가벼움). FAIL 시 `failed_stage` + service별 `logs` 추가 (디버깅 풍부). UI 단계 시각화 input.
  - **D28 = (자동)** 함수 시그니처 — `module.exports = { run, teardown }`. `await deployAgent.run({ task_id })` (lint_agent 패턴 일관). `teardown()`은 orchestrator가 PASS verdict일 때만 호출 (D6=B PASS branch).
  - **D29 = (자동)** spawn 방식 — `spawnSync` (lint_agent 일관, 동기적, 단발 실행이라 streaming 불필요).
  - **D32 = (자동)** error 분류 — Docker/Compose 미설치=FAILED+error, timeout=FAILED+logs, exit_code≠0=FAILED+logs, down 자체 실패=warn+진행, unexpected=throw→orchestrator catch.
  - **자동 처리 (옵션 비교 없이 진행)**: (1) **docker compose CLI v1/v2 자동 감지** — v2(`docker compose`)를 `--wait` flag 지원으로 우선, 미설치 시 v1(`docker-compose`)로 fallback. (2) **`--wait` flag 사용** (v2일 때만) — D14=B의 mysql healthcheck 통과까지 대기 → BE의 service_healthy 의존성 보장.
  - **schema 의존성**: `log_agent_runs.agent_name` ENUM에 `'Deploy'` 추가가 S8 schema migration에서 처리 예정. **현재 deploy_agent.js를 호출하면 ENUM 위반 SQL error 발생** → S8 완료 후에야 실제 동작 가능. 지금은 코드 작성·검토 단계.
- **89740ca**  [A] Phase 8/9 — **S5 라운드 1 (deploy_agent.js orchestrator integration sub-decision D25~D27) 잠금**.
  - **D25 = B** — Phase 8/9 실행 시점: round loop *밖*, verdict가 PASS 후보일 때만 1회 실행. round loop가 FAIL/ERROR로 종료되면 Phase 8/9 skip (이미 fail이라 deploy 의미 없음). orchestrator의 verdict 평가 흐름이 두 단계로 분리됨: round loop 종료 후 lint 결과로 1차 평가 → 1차 PASS면 Phase 8(Deploy) → Phase 9(PostTest) → 두 결과 종합으로 final verdict 결정. D5(Deploy/Test 실패 = FAIL) 정신과 일관.
  - **D26 = A** — `DEPLOY_MODE=off` 처리: `log_agent_runs`에 `agent_name='Deploy'` / `'PostTest'` row 생성 + `status='SUCCESS'` + `output_json`에 `{ skipped: 'DEPLOY_MODE=off' }`. `VALIDATION_MODE=off` 패턴(`stage_logs.skipped`)과 정확히 일관 → 두 토글이 같은 형태로 기록되어 학생 시연 시 일관성 가치. schema 변경 없음.
  - **D27 = A** — Docker 미설치 감지: deploy_agent의 첫 줄에서 `spawnSync('docker', ['--version'])` 실행. `exit_code !== 0`이면 FAILED row + 명확한 error 메시지("Docker not installed or not in PATH"). 빌드·deploy 시도 전에 진단되어 시간 낭비 없음 + 학생에게 명확한 액션 가이드.
- **89740ca**  [A] Phase 8/9 — **S4 라운드 3+4 (FE Dockerfile sub-decision D22~D24 + `.dockerignore` 추가) 일괄 처리** (사용자 명시 동의로 BE 패턴 그대로 채택, 옵션 비교 풀어쓰기 생략).
  - **D22 = A** — base image: `node:20` (BE와 동일). FE는 native module 없어 alpine도 가능했지만, BE와 통일성 우선 + 빌드 캐시 layer 공유 가능성으로 동일 image 채택.
  - **D23 = A** — install: `npm ci --no-audit --no-fund` (BE와 동일).
  - **D24 = A** — Docker layer 캐시: 분리 COPY 패턴 (BE와 동일).
  - **D13=A로 인한 CMD 차이**: BE는 `["npm", "start"]` (= `node src/server.js`), FE는 `["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]`. `--host 0.0.0.0`은 Vite dev server가 컨테이너 외부 접근 허용하도록 binding(기본은 컨테이너 안 127.0.0.1만 listen → 호스트에서 못 닿음).
  - **`.dockerignore` 추가** (BE와 FE 둘 다 lib/stack_templates 안에): 공통은 `node_modules`, `coverage`, `.git`, `*.log`, `.env`, `.env.local`, `.eslintcache`. FE 추가 항목: `dist`. `COPY . .` 단계가 host의 무거운/민감 디렉토리를 컨테이너로 복사 안 하게 차단 → 빌드 시간 ↓, 이미지 사이즈 ↓, `.env` 같은 secret 누출 위험 ↓.
  - **`stack.config.json` 변경**: `FE.protectedConfigFiles` 배열에 `"FE/Dockerfile"` 추가 (5 → 6 항목). `.dockerignore`는 protected에 추가 안 함 — Agent의 코드 응답 흐름과 무관한 설정 파일.
- **89740ca**  [A] Phase 8/9 — **S4 라운드 1 (BE Dockerfile sub-decision D19~D21) 잠금 + `lib/stack_templates/BE/Dockerfile` 작성 + `stack.config.json`의 `BE.protectedConfigFiles` 갱신**.
  - **D19 = A** — base image: `node:20` (Debian-based, ~380MB). bcrypt 같은 native module 빌드 시 precompiled binary를 활용하여 첫 빌드 ~30s. Alpine은 musl libc 이슈로 bcrypt 컴파일 ~1~2분 추가 + 학생 troubleshoot 부담이 커서 거부. 이미지 사이즈는 학생 로컬 PoC라 무관.
  - **D20 = A** — install: `npm ci --no-audit --no-fund`. package-lock.json 기준 결정론적 설치 + lock 불일치 시 fail 안전장치. PoC 결정론 정신(D5)과 일관.
  - **D21 = A** — Docker layer 캐시: 분리 COPY 패턴. `package*.json` 먼저 COPY → `npm ci` → `COPY . .`. src 변경만 있으면 `npm ci` layer가 캐시 hit되어 두 번째 빌드부터 ~10초.
  - **자동 함께 적용**: `WORKDIR /app`, `EXPOSE 3001`, `CMD ["npm", "start"]` (BE/package.json의 start 스크립트 = `node src/server.js` 활용), USER root (PoC라 USER node는 생략 — 학생 troubleshoot 부담 ↓).
  - **`stack.config.json` 변경**: `BE.protectedConfigFiles` 배열에 `"BE/Dockerfile"` 추가 (3 → 4 항목). Agent의 `validatePaths`가 차단.
  - **`lib/bootstrap.js` 코드 변경 0줄** — 기존 `listAllFiles` 재귀 복사 로직이 Dockerfile도 자동 인식.
- **89740ca**  [A] Phase 8/9 — **S3 라운드 2 (D16~D18 sub-decision) 잠금 + `lib/stack_templates/docker-compose.yml` 작성**.
  - **D16 = A** — container env strategy: docker-compose.yml에 hardcode (`DB_HOST: mysql`, `DB_PORT: 3306`, `DB_USER: root`, `DB_PASSWORD: root`, `DB_NAME: myfirstagentapp_db`, `BE_PORT: 3001`). 호스트 `.env`(orchestrator·dev용)와 container env(deploy 전용)의 명확한 분리. BE 코드의 기존 env 컨벤션(`DB_HOST/PORT/USER/PASSWORD/NAME`, `BE_PORT` — `.env.example` 및 `BE/src/db/connection.js`에 확립)을 그대로 활용 → 컨벤션 변경 없음.
  - **D17 = A** — build context 전략: deploy_agent가 `docker-compose --project-directory <project_root> -f lib/stack_templates/docker-compose.yml ...` 형태로 호출 → compose 파일 안의 paths(`./BE`, `./FE`, `./db/schema.sql`)는 프로젝트 루트 기준. 사용자 직접 docker-compose 호출 가이드는 S9에서 OPERATIONS.md에 추가.
  - **D18 = A** — MySQL image: `mysql:8` (major 버전 pin). minor patch 자동 업데이트 수용 — PoC에 적합.
  - **파일 신규 생성**: `lib/stack_templates/docker-compose.yml`. services 3개(mysql, be, fe), 핵심 동작 — mysql의 schema.sql auto-init via `/docker-entrypoint-initdb.d/`, `mysqladmin ping` healthcheck, BE의 `service_healthy` 의존성, FE의 BE 단순 의존성, 모든 ports는 env 기반(default fallback 포함). 컨테이너 stay-in-place(D17=A)라 bootstrap이 docker-compose.yml은 안 건드림(BE/FE Dockerfile만 복사 예정).
- **89740ca**  [A] Phase 8/9 — **S3 라운드 1 (docker-compose.yml 구조 결정 D11~D15) 잠금** (추천 묶음 전체 채택).
  - **D11 = A** — 컨테이너 build 전략: Dockerfile in BE/, FE/. docker-compose `build:` 지시로 매 task 시작 시 이미지 빌드. Docker layer cache 덕에 두 번째 실행부터 ~10초. 학생 시연 시 Dockerfile 학습까지 포함되는 풀 루프 가치가 결정적.
  - **D12 = A** — Dockerfile 위치: `lib/stack_templates/BE/Dockerfile`, `lib/stack_templates/FE/Dockerfile` 신규. `lib/bootstrap.js`가 BE/, FE/ 루트로 복사. `stack.config.json`의 `BE.protectedConfigFiles`, `FE.protectedConfigFiles`에 각각 추가하여 Agent의 수정 차단. 기존 stack templating 패턴과 100% 일관.
  - **D13 = A** — FE 서빙 방식: Vite dev server (`npm run dev -- --host 0.0.0.0`, 포트 5173). 학생이 평소 보는 환경과 동일. Production 서빙(nginx)은 미래 단계로 미룸.
  - **D14 = B** — depends_on / healthcheck: mysql healthcheck (`mysqladmin ping`, interval 5s, retries 20) + BE의 `depends_on: mysql: condition: service_healthy`. mysql이 진짜 준비된 후 BE 시작 보장. BE healthcheck는 PostTest가 자체 retry로 처리하므로 추가 안 함.
  - **D15 = A** — restart policy: `restart: "no"`. PoC 결정론 검증에 fail이 즉시 surface되어야 함. 재시도는 orchestrator 책임 영역(D5).
  - **다음 라운드 (S3 라운드 2)**: docker-compose.yml 작성 시 발견되는 sub-decision (DB env var 이름, MySQL credentials 처리 등) 사용자 응답 후 진행.
- **89740ca**  [A] Phase 8/9 — **S2 (부수 결정 D6~D10) 잠금** (추천 묶음 전체 채택).
  - **D6 = B** — `docker-compose down` 정책: PASS면 down, FAIL/ERROR면 컨테이너 보존(디버깅용). 추가 책임: deploy 시작 전 항상 `docker-compose down` 선행 호출 필수(잔존 컨테이너 충돌 방지). `agents/deploy_agent.js`의 첫 동작.
  - **D7 = C** — 포트 정책: env 3개(`DEPLOY_PORT_FE` 기본 5173, `DEPLOY_PORT_BE` 기본 3001, `DEPLOY_PORT_DB` 기본 3306)로 toggle, 충돌 시 ERROR. SSAFY 학생 환경에서 3306 충돌이 흔한 점 고려. docker-compose.yml에서 `${DEPLOY_PORT_FE}:5173` 같은 변수 참조 패턴.
  - **D8 = C** — `DEPLOY_MODE=on|off` 토글: ON 기본, Docker 미설치 시 ERROR(명확). OFF면 Phase 8/9 통째 SKIPPED + log_agent_runs에 SUCCESS(skipped 명시) + verdict는 Phase 4 결과로. **CLAUDE.md 절대 규칙 #9로 추가 예정** — `VALIDATION_MODE`와 동일 패턴이라 학생 시연 시 "결정론적 *검증* 토글 + 결정론적 *배포* 토글" 일관성이 교육 가치.
  - **D9 = C** — MySQL volume: ephemeral. `/var/lib/mysql` mount 안 함 → 컨테이너 lifetime에 데이터 묶임 → 매 task fresh DB → 결정론 보장(회원가입 중복 검사 같은 idempotent 테스트 안전). `db/schema.sql`을 `/docker-entrypoint-initdb.d/schema.sql:ro`로 mount → MySQL 공식 image의 자동 init 활용 → 추가 init_db 호출 불필요. 시작 속도 ~10s 추가 trade-off 수용.
  - **D10 = A 보강** — docker logs 보존: 마지막 N줄(기본 200)을 `log_agent_runs.output_json`(Deploy/PostTest row의)에 저장 + `LOG_TAIL_LINES` env로 토글(200/500/2000). 200줄 이상 디버깅은 D6=B 시너지로 살아있는 컨테이너에서 `docker logs --tail N <container>` 직접 추출 안내.
  - **누적 신규 env 5개** (S9에서 `.env` + `.env.example` 동기 갱신 — `feedback_env_var_pairing.md` 적용): `DEPLOY_PORT_FE`, `DEPLOY_PORT_BE`, `DEPLOY_PORT_DB`, `DEPLOY_MODE`, `LOG_TAIL_LINES`.
- **89740ca**  [A] Phase 8/9 (Deploy + Post-deploy Test) 구현 진행 시작 — 결정 라벨링 D1~D10 정의 + S1 잠금. 이전 plan-eng-review 세션의 D1~D11 plan은 plan-mode in-memory였고 본문이 어디에도 저장되지 않아 소실. → 메모리(`project_myfirstagentapp_roadmap.md` [A] 섹션) 및 `docs/ROADMAP.md` 1순위 섹션에 보존된 *잠긴 결정 5 + 부수 항목 5*를 D1~D10으로 재매핑.
  - **D1~D5 (잠긴 결정, 2026-05-08 사용자 사전 승인)**:
    - D1 = 배포 구현 = **결정론 템플릿** (LLM X, `lib/stack_templates/`에 docker-compose.yml)
    - D2 = 배포 타겟 = **로컬 docker-compose** (FE+BE+MySQL)
    - D3 = 테스트 구현 = **결정론** (CodeChecker가 만든 `api_contract` 활용)
    - D4 = 테스트 깊이 = **API contract schema 검증** (request/response shape)
    - D5 = verdict 통합 = **Deploy/Test 실패 = verdict=FAIL**
  - **D6~D10 (부수 항목, 본 세션에서 차례로 잠금)**:
    - D6 = docker-compose down 자동화 정책
    - D7 = 포트 충돌 정책 (5173 / 3001 / 3306)
    - D8 = Docker 미설치 환경 fallback
    - D9 = MySQL volume mount 정책
    - D10 = docker logs 보존 방식·양
  - **S1 잠금 (본 세션 신규 결정)**: Phase 8/9 row 모델 = **옵션 B-기본**. `log_agent_runs.agent_name` ENUM에 `'Deploy','PostTest'` 추가(ALTER 1회). Deploy/PostTest는 결정론·1회 단발이라 `log_task_state`에 row 안 만듦 — 현행 BE/FE만 유지. 상세 docker logs는 `log_agent_runs.output_json`에, `log_agent_decisions.final_result_text`엔 한 줄 요약만. **책임 분리 원칙**: *decisions = verdict 영수증, runs = phase별 작업 일지.* 단점: UI 단계에서 phase 시각화 시 두 테이블 join 필요.
  - **진행 방식 (본 세션 사용자 합의)**: S1~S9 단계로 분할, 각 단계 잠금마다 DECISIONS.md에 entry 추가, 채팅에 step-by-step status 표 표시. 인프라 코드(docker-compose.yml, Dockerfile, deploy_agent 등)는 파일 1개당 옵션 제시 후 사용자 응답받고 진행 (메모리 `feedback_deploy_infra_step_by_step.md` 따름).
- **(TBD)**  Prompt caching API 단순화 + CodeChecker 캐싱 추가 — 기존 `cache: boolean`(true=system 캐시) → `cache: 'system' | 'user'`로 enum화. BE/FE Agent는 system이 무거워(`'system'`) rules를 캐시, CodeChecker는 user_request가 큰 경우(`'user'`) user 메시지를 캐시. **인사이트**: "Agent마다 콘텐츠 분포가 다르다 — 캐싱 전략도 그에 맞춰 다르게." 같은 spec으로 orchestrator 재실행 시 (디버깅·시연 반복) CodeChecker도 5분 TTL 안에서 ~90% 절감. user_request가 캐시 임계값(Sonnet 1024, Haiku 2048 토큰) 미달이면 자동 no-op으로 안전. `cache: 'both'`는 의도적으로 안 추가 (현 3개 Agent 중 어느 것도 system+user 둘 다 무겁지 않음 — YAGNI).
- **(TBD)**  [C] dotenv override 정책 변경 **기각** — UI 단계 진입 시 dotenv `override: true` → `false`로 바꾸는 안을 검토했으나, 사용자가 더 단순한 대안 채택: UI가 `.env` 파일을 직접 수정하면 됨. 정책 변경, API key 가드 추가, 절대 규칙 갱신 모두 불필요. 사고 모델: "`.env`가 single source of truth, UI는 그것의 GUI 에디터." UI scope에 `.env` writer 유틸(atomic write로 tmp+rename) 추가될 예정. 교육적 의미: "**프레임워크 사상(env 우선순위)에 끌려가지 말고 PoC 규모에 맞는 단순한 답을 고르기**" 결정 사례.
- **(TBD)**  Prompt caching 도입 — `lib/llm.js`의 `callJSON()`에 `cache: true` 옵션 추가, BE/FE Agent의 system prompt에 rules 본문을 포함시켜 모듈 로드 시점에 한 번만 빌드. system prompt를 `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]`로 마킹해 5분 TTL 캐시 활성. 재시도 호출이나 같은 라운드 내 다음 호출에서 ~90% 입력 비용 절감. 사용량 통계는 콘솔에 `[llm:<agent>] cache hit/write` 로그.
- **5365d2d**  문서 구조 분리 — CLAUDE.md를 슬림화하고 `docs/`(PRD, ARCHITECTURE, OPERATIONS, DECISIONS, ROADMAP)와 `rules/`(common.md, be.md, fe.md)로 분산. Agent prompt 다이어트(BE는 BE 규칙만, FE는 FE 규칙만)와 다음 세션 cold-start 효율 향상이 목적.
- **0e2b6e4**  문서 구조 분리 — Phase 1 (additive) — 새 docs/와 rules/ 파일 추가 (구 code_convention.md는 보존, 코드 변경 X).
- **cff5842**  Agent별 LLM 모델 분리 — `CODECHECKER_MODEL` / `BE_AGENT_MODEL` / `FE_AGENT_MODEL` env로 토글, `ANTHROPIC_MODEL` fallback. `lib/llm.js`에 `resolveModel(agent)` 헬퍼 추가.
- **c6417ac**  VALIDATION_MODE 도입 — off면 Phase 4 (Lint) 통째 skip, log_task_state 자동 SUCCESS. Ablation/디버깅 모드. validatePaths 같은 안전장치는 모드 무관 항상 켜짐.

## 2026-05-07

- **6a778d9**  CLAUDE.md docs 정리 — Phase 7 (auto-commit), Phase 6 (finalize) 다이어그램 추가, troubleshooting 표 보강.
- **b6212e1**  COMMIT_MODE 도입 + pre-push gate 제거 — verdict=PASS && COMMIT_MODE=auto일 때 orchestrator가 BE/+FE/만 자동 commit. push는 항상 사람이. 사람의 commit/push는 모드 무관 자유.
- **b41aee3**  login + LoginForm 추가 (signup 보존).
- **2613b5f**  jsonrepair 폴백을 LLM JSON 파서에 추가.
- **3597f77**  pre-push 게이트 (main push는 verdict=PASS 필요) — 후속 commit b6212e1에서 제거됨.
- **4d7faf5**  initial commit (전체 시스템).

## 결정의 맥락 (왜 이렇게 갔나)

### COMMIT_MODE / VALIDATION_MODE 패턴
두 토글 모두 같은 env 패턴 사용 (`<MODE_NAME>=on|off` 또는 `auto|manual`). 의도는:
- 결정론적 검증과 LLM 출력을 깨끗이 분리 (VALIDATION_MODE=off면 LLM 원시 출력 노출)
- 자동화 영역과 사람 영역의 명확한 경계 (commit은 사람의 결정, validation은 도구의 일)

### Per-agent 모델 분리
같은 모델로 모든 Agent를 돌리는 건 낭비. CodeChecker는 분류 작업이라 빠른 Haiku로 충분, BE/FE는 코드 생성이라 Sonnet 이상 권장. 비용·속도 최적화의 출발점.

### 문서 구조 분리 (2026-05-08)
CLAUDE.md가 monolithic해지면서 (190+ lines):
1. Claude Code 자동 로드 시 큰 토큰 소모
2. BE Agent에 FE 규칙도 같이 주입돼 prompt noise
3. 섹션별 갱신 주기 다른데 한 파일에 묶여 stale 위험

→ 인덱스/규칙(CLAUDE.md) ↔ 상세(docs/) ↔ Agent prompt(rules/) 3계층 분리.

### Pre-push gate 제거 (2026-05-07)
원래는 `main` push 전 `verdict=PASS` DB 검사로 막았으나:
- 사람의 push까지 검사하는 건 사용자 의도와 어긋남 (사람은 자기 책임)
- DB에 마지막 PASS만 보고, 디스크의 실제 코드 변경은 추적 못 함 (stale risk)
- COMMIT_MODE 도입으로 "파이프라인이 만든 변경"만 자동 commit → push 게이트 자체가 무의미해짐

→ 게이트 제거, 사람 push는 자유, 파이프라인 commit만 모드로 토글.
