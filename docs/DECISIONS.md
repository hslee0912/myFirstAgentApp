# Decision Log

시간순 결정 기록. 최근 3개는 [CLAUDE.md](../CLAUDE.md)에도 미러.

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
