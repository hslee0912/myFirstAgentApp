# MyFirstAgentApp — Multi-Agent Code Generation PoC

자연어 요구사항 → **CodeChecker → BE/FE Agent → 정적 가드 4종 → Lint → Deploy → PostTest** 자동 파이프라인. Claude Code 같은 어시스턴트 없이 *자율 동작*하는 게 목표.

> **핵심 룰·다이어그램은 [CLAUDE.md](CLAUDE.md)에 있습니다.** 이 README는 *신규 환경 setup + 실행 가이드* 위주.

---

## 1. 파이프라인 한눈에

```
사용자 요청 (자연어 명세서, tmp_big_prompt_run.txt 또는 UI 입력창)
  └─ Orchestrator (LLM X, 결정론 컨트롤러)
      ├─ Phase 1   CodeChecker (LLM)         → FE/BE/BOTH 분류 + spec + api_contract
      ├─ Phase 2   BE Agent (LLM)            → BE/ 코드 + migrations + Jest
      ├─ Phase 2.5 Migration Agent (LLM X)   → BE/db/migrations/*.sql 자동 적용 (D33)
      ├─ Phase 2.7 ContractSync Agent (LLM X)→ endpoint mount 정적 diff (D36)
      ├─ Phase 2.8 SpecSync Agent (LLM X)    → spec/scenarios ↔ rules/domain.md 카탈로그 정적 검증 (D89~D92)
      ├─ Phase 3   FE Agent (LLM)            → FE/ 코드 + Vitest+RTL
      ├─ Phase 4   Lint Agent (LLM X)        → ESLint + Build + Tests (3-stage)
      ├─ Phase 5   verdict (LLM X)           → PASS / FAIL / ERROR / CONTINUE(재진입)
      ├─ Phase 8   Deploy Agent (LLM X)      → docker compose up (subnet 172.20 고정, D93)
      ├─ Phase 9   PostTest Agent (LLM X)    → api_contract 기반 runtime fetch + schema 검증
      ├─ Phase 6   finalize (LLM X)          → log_agent_decisions UPDATE
      ├─ Phase 7   auto-commit (LLM X)       → PASS면 BE/+FE/ 자동 commit (push X)
      └─ Phase 7.5 deploy teardown           → PASS면 docker compose down
```

LLM은 **CodeChecker · BE · FE Agent 안에서만** 호출. 나머지는 결정론.

---

## 2. 디렉토리 구조 (현재)

```
myFirstAgentApp/
├── agents/
│   ├── orchestrator.js               # 전체 흐름 제어 (LLM X)
│   ├── codechecker_agent.js          # Phase 1 (LLM)
│   ├── be_agent.js                   # Phase 2 (LLM)
│   ├── fe_agent.js                   # Phase 3 (LLM)
│   ├── migration_agent.js            # Phase 2.5
│   ├── contract_sync_agent.js        # Phase 2.7 (D36)
│   ├── spec_sync_agent.js            # Phase 2.8 (D89~D92)
│   ├── lint_agent.js                 # Phase 4 (3-stage gate)
│   ├── deploy_agent.js               # Phase 8
│   └── test_agent.js                 # Phase 9 (PostTest)
├── lib/
│   ├── llm.js                        # Anthropic SDK 래퍼 (모델 cap-aware max_tokens)
│   ├── logger.js                     # log_agent_* 헬퍼
│   ├── db.js / init_db.js / reset_db.js
│   ├── bootstrap.js                  # BE/FE 스캐폴딩
│   ├── api_test.js                   # api_contract → fetch + schema 검증
│   ├── contract_sync.js              # endpoint mount 정적 diff (D36)
│   ├── spec_sync.js                  # spec/scenarios 카탈로그 일치 + cross-endpoint 검증 (D89~D92)
│   ├── migration_sanity.js / container_sanity.js / container_cleanup.js / docker_health.js
│   ├── dep_autofix.js / fe_contract_guard.js / agent_error_classifier.js
│   ├── prompt_util.js / fs_util.js / test_codegen.js / resume_helper.js / port_killer.js
│   ├── env_writer.js / db_state.js
│   ├── stack.js / stack.config.json
│   └── stack_templates/
│       ├── docker-compose.yml        # Phase 8 (subnet 172.20.0.0/16 고정, D93)
│       ├── BE/src/validators.js      # 🔒 결정론 placeholder (D88)
│       ├── BE/Dockerfile + .dockerignore + package.json + ...
│       └── FE/vite.config.js (hmr:false, D91) + Dockerfile + ...
├── rules/
│   ├── common.md                     # BE+FE 공통 규칙 (자동 inject)
│   ├── be.md / fe.md / db.md         # 영역별 규칙
│   └── domain.md                     # 도메인 필드 카탈로그 (D87~D92)
├── docs/
│   ├── PRD.md / ARCHITECTURE.md / OPERATIONS.md / DECISIONS.md / ROADMAP.md
│   ├── SPEC_WRITING.md               # 명세서 작성 가이드 (모호 표현 anti-pattern)
│   └── SPEC_TEMPLATE.md              # 신규 게임 명세서 빈 템플릿
├── ui/
│   ├── server.js                     # Express UI server (port 3000)
│   ├── public/                       # 대시보드 HTML/JS
│   └── routes/                       # /api/init, /api/run, /api/tasks, /api/env, /api/git, /api/deploy
├── scripts/
│   ├── launch-ui.sh                  # npm run ui
│   ├── run-10-cycles.sh              # 배치 cycle (PROMPT_FILE env 지원, D93)
│   └── monitor-cycle.sh
├── tests/                            # 25개 단위 테스트 (436 PASS 기준)
├── shared/api_contract.json + router/
├── db/agent_schema.sql               # log_* tables (SpecSync ENUM 포함, D89)
├── BE/, FE/                          # bootstrap이 깐 placeholder, Agent가 채움
├── tmp_big_prompt_run.txt            # 기본 명세서 (CLI/UI에서 사용)
├── .vscode/settings.json             # EC2 Remote-SSH 검색 최적화
└── .env / .env.example
```

---

## 3. 사전 요구사항

- **Node.js >= 18**
- **MySQL 8** (호스트 또는 별도 컨테이너)
- **Docker Compose v2** (Phase 8/9, `DEPLOY_MODE=off`면 불필요)
- **Nginx** (외부 도메인·HTTPS 시연 시. 로컬 개발은 선택)
- **ANTHROPIC_API_KEY** (`.env`)

---

## 4. 설치 & 실행

### 4-1. 환경 변수

```bash
cp .env.example .env
# .env 열어 다음 입력:
#   ANTHROPIC_API_KEY=sk-ant-...
#   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
#   COMMIT_MODE=auto       # verdict=PASS 시 BE/+FE/ 자동 commit (push 안 함)
#   VALIDATION_MODE=on     # Phase 4 Lint 게이트 활성
#   DEPLOY_MODE=on         # Phase 8/9 활성
```

### 4-2. 의존성 + DB 초기화

```bash
npm install
npm run init-db       # db/agent_schema.sql 적용 (log_* + ENUM 포함)
```

FE/BE 의존성은 Orchestrator 첫 실행 시 `lib/bootstrap.js`가 자동 `npm install`.

### 4-3. UI 서버 실행 (권장)

```bash
npm run ui
```

- Express UI server 가 port 3000 listen
- 브라우저 http://localhost:3000 또는 (Nginx reverse proxy 시) http://your-domain/
- 대시보드에서:
  - **InitProject** 버튼 → git reset --hard origin/main + BE/src·FE/src 삭제 + DB log reset
  - **prompt 입력 + Run Pipeline** 버튼 → orchestrator child spawn
  - 작업 history·verdict·phase별 진행 polling

### 4-4. CLI 직접 실행 (선택)

```bash
node agents/orchestrator.js --file=./tmp_big_prompt_run.txt
# 또는
node agents/orchestrator.js "회원가입 + 종스크롤 슈팅 게임 만들어줘"
```

### 4-5. 배치 cycle (시연·테스트용)

```bash
N_CYCLES=1 bash scripts/run-10-cycles.sh                                   # 기본 명세서
PROMPT_FILE=tmp_big_prompt_run_2.txt N_CYCLES=1 bash scripts/run-10-cycles.sh   # 다른 명세서
```

InitProject → restore_fixes → Run pipeline → polling → 결과 집계 (`/tmp/10cycles_results.tsv`).

---

## 5. 결정론 가드 누적 (D87~D93, 2026-05-20)

| Decision | 효과 |
|---|---|
| **D87** `rules/domain.md` 도메인 필드 카탈로그 + CodeChecker/BE Agent prompt inject | endpoint 간 validator drift 차단 (username/password 등) |
| **D88** `lib/stack_templates/BE/src/validators.js` placeholder + `protectedConfigFiles` | LLM 자유추론 영역 박탈 (validator) — `signup`/`check`/`login` 동일 함수 강제 |
| **D89** Phase 2.8 **SpecSync Agent** (`lib/spec_sync.js` + `agents/spec_sync_agent.js`) | spec.pattern · scenarios 카탈로그 일치 정적 검증 |
| **D90** SpecSync `cross_endpoint_username_collision` | signup `valid_*` username과 check `available_*` username 충돌 차단 |
| **D91** Vite `hmr: false` + Let's Encrypt HTTPS (`certbot --nginx`) | https mixed content 0, WebSocket 사용처 0 |
| **D92** SpecSync `credential_seed_mismatch` | `valid_credentials` password = `Pass1234` (시드 hash 매핑값) 강제 |
| **D93** docker-compose subnet 고정 (`172.20.0.0/16`) + cycle PROMPT_FILE env | random subnet → UFW 미스 차단, 결정론적 BE→MySQL |

자세한 결정 맥락은 [docs/DECISIONS.md](docs/DECISIONS.md).

---

## 6. 모드 토글 (`.env`)

| 변수 | 기본 | 효과 |
|---|---|---|
| `COMMIT_MODE` | `auto` | `auto`면 verdict=PASS 시 BE/+FE/ 자동 commit (push는 사람). `manual`이면 자동 commit 안 함 |
| `VALIDATION_MODE` | `on` | `off`면 Phase 4 Lint 전체 skip + log_task_state 자동 SUCCESS |
| `DEPLOY_MODE` | `on` | `off`면 Phase 8/9 통째 skip + log_agent_runs 자동 SUCCESS |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | 전체 fallback 모델 |
| `CODECHECKER_MODEL` / `BE_AGENT_MODEL` / `FE_AGENT_MODEL` | (빈 값) | Agent별 모델 override |

해석 우선순위: `<AGENT>_MODEL` → `ANTHROPIC_MODEL` → 하드코딩 default.

---

## 7. HTTPS 셋업 (선택, EC2/외부 도메인)

D91 적용. Let's Encrypt + certbot:

```bash
sudo apt-get install -y python3-certbot-nginx
sudo certbot --nginx -d <도메인> --non-interactive --agree-tos -m <이메일> --redirect
```

- `--redirect`로 nginx에 http→https 301 자동
- `/etc/cron.d/certbot` + `certbot.timer`로 90일 만료 30일 전 자동 갱신
- UFW에 443 인바운드 허용 + AWS SG도 443 허용 필요

EC2 환경에서 docker subnet UFW 트랩 회피:
```bash
sudo ufw allow from 192.168.0.0/16 to any port 3306 proto tcp   # docker compose가 192.168 잡을 때 대비
# (172.16.0.0/12 룰은 D93 기본 subnet 172.20 커버)
```

자세한 절차는 [docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## 8. 데이터베이스 — 단일 DB `myfirstagentapp_db`

`db/agent_schema.sql`에 log_* tables 정의 (`SpecSync` / `SPEC_SYNC` ENUM 포함):

| 테이블 | 용도 | INSERT | UPDATE |
|---|---|---|---|
| `log_agent_runs` | Agent별 실행 row | 각 Agent | 각 Agent (자기 row만) |
| `log_agent_decisions` | task당 1행 최종 판정 | CodeChecker | Orchestrator |
| `log_task_state` | FE/BE 영역별 상태 | CodeChecker | Lint / SpecSync / ContractSync |
| `log_db_migrations` | 비즈니스 migration 이력 (D33) | Migration Agent | — |

비즈니스 schema는 BE Agent가 `BE/db/migrations/<ts>_<name>.sql` emit → Phase 2.5 Migration Agent가 자동 적용 + 이력 추적.

---

## 9. 핵심 규칙 (불변)

자세한 룰은 [CLAUDE.md](CLAUDE.md). 요약:

1. **폴더 격리** — BE Agent는 `BE/`만, FE Agent는 `FE/`만 (`validatePaths` 차단)
2. **protected 파일** — `package.json`/`vite.config.js`/`BE/src/validators.js` 등 응답 포함 시 차단
3. **allowedDeps만** — 새 의존성·매니페스트 수정 금지
4. **Placeholder 보존** — bootstrap이 깐 `server.test.js`/`App.test.jsx`/`validators.js`는 수정 불가
5. **Stage 3 (테스트) 실패** = 즉시 verdict=FAIL 종료, 재시도 없음
6. **재시도 최대 3회** (Stage 1·2 한정)
7. **LLM 호출** = CodeChecker / BE / FE Agent만. 나머지 결정론.
8. **자동 commit은 `BE/`+`FE/`만**, `push`는 항상 사람 (commit_mode=auto일 때)

---

## 10. 스택 변경 체크리스트

FE 또는 BE 스택을 바꾸려면 **두 곳만** 수정:

### 필수
- [ ] `lib/stack.config.json` 해당 영역 블록 (displayName / install / lint stages / agent / snapshot / eslintConfig / protectedConfigFiles)
- [ ] `lib/stack_templates/<AREA>/` placeholder 파일 (bootstrap이 자동 복사)

### 부수
- [ ] `rules/common.md` / `rules/be.md` / `rules/fe.md` / `rules/db.md` / `rules/domain.md`
- [ ] `README.md` 본 문서

### 작업 순서
1. `lib/stack_templates/<AREA>/` 폴더 내용 교체
2. `lib/stack.config.json` 의 `<AREA>` 블록 갱신
3. 기존 `<AREA>/` 폴더 삭제 (`rm -rf BE` 등)
4. UI Run 또는 `npm start` → bootstrap이 새 placeholder 깔고 cycle 진행

---

## 11. 명세서 작성 가이드 (신규 게임)

PoC 핵심: *자연어 명세서를 LLM이 그대로 구현*. 명세서 모호함 = LLM 임의 채움 → 결과 다양성.

| 문서 | 용도 |
|---|---|
| [docs/SPEC_WRITING.md](docs/SPEC_WRITING.md) | 9개 카테고리 체크리스트 (상태 변수·이벤트 시점·적 AI·UI HUD·CRUD·동시성·boundary·모호 자가체크·PoC 메시지) |
| [docs/SPEC_TEMPLATE.md](docs/SPEC_TEMPLATE.md) | 빈 게임 명세서 템플릿 (copy → `tmp_big_prompt_run.txt`) |
| [tmp_big_prompt_run.txt](tmp_big_prompt_run.txt) | 현재 사용 중인 명세서 (판타지 슈팅 게임 사례) |
| [lib/stack_templates/FE/src/constants/game.js](lib/stack_templates/FE/src/constants/game.js) | **🔒 결정론 placeholder** — 게임별 상수 (수치·enum·색·매핑). bootstrap이 자동 깜, protectedConfigFiles로 수정 차단 |

### 🚨 가장 중요한 룰 — **게임 변경 시 두 파일 *짝으로* 갱신**

**`tmp_big_prompt_run.txt` (명세서) + `lib/stack_templates/FE/src/constants/game.js` (placeholder)** 는 *같은 게임의 두 표현*. **항상 함께 갱신**.

| 시나리오 | 잘못된 방법 | 올바른 방법 |
|---|---|---|
| 게임을 슈팅 → 퍼즐로 교체 | tmp만 수정 → placeholder는 슈팅 상수 그대로 → LLM이 *부적합한 STAGES·WEAPONS* import 시도 → 회귀 | tmp + placeholder를 *동시에* 퍼즐 게임용으로 교체 |
| 새 무기 추가 (5종으로 확장) | placeholder의 `WEAPONS` 배열만 +1 → 명세서엔 4종 그대로 | placeholder + tmp 둘 다에 새 무기 명시 |
| 배경색 변경 | tmp에 새 hex 명시 → placeholder엔 옛 hex | placeholder의 `STAGES[i].bgColor` 갱신 후 tmp의 *placeholder 참조 표현*은 그대로 (값은 placeholder에서 자동 반영) |

### placeholder가 single source of truth인 이유

| 메커니즘 | 역할 |
|---|---|
| **bootstrap** (`lib/bootstrap.js`) | cycle 시작 시 `lib/stack_templates/FE/src/constants/game.js`를 `FE/src/constants/game.js`에 자동 복사 (명세서 무관) |
| **protectedConfigFiles** (`stack.config.json.FE`) | FE Agent가 응답에 `FE/src/constants/game.js` 포함 시 `validatePaths` 차단 — LLM이 *수정 불가* |
| **명세서 참조** (`tmp_big_prompt_run.txt`) | "이 게임의 수치·enum은 placeholder가 SoT" 명시 → LLM이 *import해서 사용* |

→ **수치를 한 곳(`placeholder`)에 박아두고 *명세서는 참조만***. 게임 변경 시 placeholder 한 번 교체로 모든 게 따라옴.

### 명세서 작성 시 체크

- **🔒 §0 또는 상단에 placeholder 위치 명시** — `lib/stack_templates/FE/src/constants/game.js` 참조 룰
- *모호 표현 금지* (`적당히`/`잘`/`필요시` 등 12개 단어 → 수치·단위·조건으로)
- *허용 + 금지* 모두 명시 (❌ → ✅ → 🚫 3단)
- `rules/domain.md §2~§3` 카탈로그 글자 그대로 사용 (username/password/HTTP status/error message)
- **인라인 hex/enum literal/수치는 명세서에 적지 말 것** — placeholder가 SoT
- 명세서 본문에서 값을 인용해야 하면 `STAGES[i].bgColor` 같은 *placeholder 참조*로 표현

---

## 12. 트러블슈팅

| 증상 | 원인·해결 |
|---|---|
| `Cannot find module '@anthropic-ai/sdk'` | `npm install` 실행 |
| MySQL 연결 실패 | `.env` DB 접속 정보, MySQL 서버 기동, UFW 3306 허용 |
| 첫 cycle이 너무 오래 (5분+) | FE/BE의 `npm install` 1회. 이후 빠름 |
| Lint Stage 3 FAIL → 즉시 종료 | 정책상 재시도 없음. DB `log_task_state.stage_logs`에서 실패 상세 확인 |
| **PostTest timeout (60s)** | BE → MySQL `ETIMEDOUT` — docker subnet이 UFW 룰 밖. D93 적용 후 subnet 172.20.0.0/16 고정으로 해결됨 |
| Vite "Blocked request: prof23.p.ssafy.io" | `vite.config.js`에 `allowedHosts: true` (이미 적용) |
| https 페이지 mixed content 경고 | D91 — `vite.config.js` `hmr: false`로 해결 (이미 적용) |
| `git reset --hard` 후 작업 분 사라짐 | UI `/api/init`이 git reset 동반. 사람의 변경분은 *push 먼저 → InitProject* 순서. cycle script는 `/tmp/myapp-fix/`에 백업 후 `restore_fixes()`로 복원 |
| SpecSync FAIL `credential_seed_mismatch` | `valid_credentials` scenario password ≠ `Pass1234`. D92 룰. CodeChecker prompt 따르면 자동 해결 |
| docker subnet random → UFW 미스 | D93 — `lib/stack_templates/docker-compose.yml`에 subnet 172.20.0.0/16 고정 |
| Windows 환경 | 모든 npm 자식 프로세스는 `shell: true`, path 구분자는 `path.join`으로 통일 |

추가 진단·자주 하는 작업: [docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## 13. 운영 환경 (현재)

- **Primary**: EC2 (prof23.p.ssafy.io) 단일 환경
- **HTTPS**: Let's Encrypt (만료 2026-08-18, 자동 갱신)
- **Nginx reverse proxy**: `/` → UI (3000), `/api/v1/*` → BE (3001), `/demo/*` → FE Vite (5173)
- **Docker subnet**: 172.20.0.0/16 고정
- **Workflow**: 단일 worktree (`claude/test` branch) → `git push origin claude/test:main` ff push
