# MyFirstAgentApp — Multi-Agent Signup System (PoC)

자연어 요구사항 → CodeChecker → BE Agent → FE Agent → Lint Agent (3단계 게이트) 순으로 동작하는
멀티 에이전트 코드 생성/검증 시스템의 PoC.

## 디렉토리 구조

```
myFirstAgentApp/
├── agents/
│   ├── codechecker_agent.js     # 요구사항 분석 + api_contract 생성 (LLM)
│   ├── be_agent.js              # BE/ 코드 + Jest 테스트 작성 (LLM)
│   ├── fe_agent.js              # FE/ 코드 + Vitest+RTL 테스트 작성 (LLM)
│   ├── lint_agent.js            # ESLint → Build → Test 3단계 검증 (LLM X)
│   └── orchestrator.js          # 전체 흐름 제어 (LLM X)
├── lib/
│   ├── db.js                    # mysql2 풀
│   ├── logger.js                # log_agent_runs / log_agent_decisions / log_task_state 헬퍼
│   ├── llm.js                   # @anthropic-ai/sdk 래퍼
│   ├── bootstrap.js             # FE/BE 스캐폴딩 (Vite + Express)
│   ├── fs_util.js               # 경로 안전 검증 + 파일 스냅샷
│   └── init_db.js               # schema.sql 실행
├── rules/
│   └── code_convention.md       # BE/FE Agent가 매 실행 시 읽음
├── db/
│   └── schema.sql               # 단일 DB (myfirstagentapp_db) 4 tables
├── shared/
│   └── api_contract.json        # CodeChecker가 BOTH일 때 작성
├── FE/                          # 1회 부트스트랩 후 FE Agent가 채움
├── BE/                          # 1회 부트스트랩 후 BE Agent가 채움
├── .env.example
├── package.json
└── README.md
```

## DB 설계 (단일 DB: `myfirstagentapp_db`)

| 테이블 | 용도 | INSERT | UPDATE |
|---|---|---|---|
| `app_users` | 회원가입 비즈니스 | BE 코드 (런타임) | — |
| `log_agent_runs` | Agent별 실행 row | 각 Agent | 각 Agent (자기 row만) |
| `log_agent_decisions` | task당 1행 최종 판정 | CodeChecker | Orchestrator |
| `log_task_state` | FE/BE 영역별 상태 | CodeChecker | Lint |

## 설치 & 실행

### 1) 환경 변수
```bash
cp .env.example .env
# .env 열어서 ANTHROPIC_API_KEY와 DB 접속 정보 입력
```

### 2) 의존성
```bash
npm install
```
FE/BE 의존성은 Orchestrator가 첫 실행 시 자동으로 `npm install` 합니다 (`lib/bootstrap.js`).

### 3) DB 초기화
```bash
npm run init-db
```
또는 직접:
```bash
mysql -u root -p < db/schema.sql
```

### 4) 실행

기본 시나리오(회원가입):
```bash
npm start
```

직접 요구사항 전달:
```bash
node agents/orchestrator.js "이메일과 비밀번호로 회원가입할 수 있는 기능을 만들어줘. 비밀번호는 8자 이상, 이메일 중복 체크 필수."
```

파일에서 읽기:
```bash
node agents/orchestrator.js --file=./my_request.txt
```

## 실행 흐름 (6 Phase)

```
Phase 0  Orchestrator 시작 + FE/BE 부트스트랩
Phase 1  CodeChecker (LLM)         → log_agent_decisions INSERT, log_task_state INSERT (1~2행)
─────  라운드 사이클 ─────
Phase 2  BE Agent (LLM)            → BE/ 코드 + 테스트
Phase 3  FE Agent (LLM)            → FE/ 코드 + 테스트
Phase 4  Lint Agent (LLM X)        → Stage1 ESLint → Stage2 Build → Stage3 Tests
                                     판정 결과를 log_task_state에 UPDATE
Phase 5  Orchestrator 판정 (우선순위 단일 평가):
           ① ERROR  : 어떤 log_agent_runs라도 FAILED
           ② PASS   : 모든 영역 SUCCESS
           ③ FAIL   : Stage 3 실패 (재시도 없음)
           ④ FAIL   : retry_count >= 3
           ⑤ CONTINUE : 위 조건 모두 미해당 → 다음 라운드 (FAILED 영역만)
─────────────────────────
Phase 6  log_agent_decisions UPDATE, Orchestrator log_agent_runs UPDATE,
         콘솔에 [VERDICT] task_id=... 출력
```

## 재시도 부분수정 정책 (옵션 C)

Lint가 Stage 1 또는 Stage 2에서 fail하면 Orchestrator가 다음 라운드에 BE/FE Agent를
**`retry` 모드**로 호출:
- `existing_files`: 현재 디스크의 파일 스냅샷
- `allowed_paths`: `fix_instructions`에서 추출한 파일 경로 + 짝 테스트 파일
- `fix_instructions`: Lint Stage의 stdout/stderr 요약
- Agent는 `allowed_paths` 외의 파일을 수정하면 안 됨. Orchestrator가 응답 검증.

## 핵심 규칙 (불변)

1. BE Agent는 `BE/`만, FE Agent는 `FE/`만 수정.
2. `log_agent_decisions`는 CodeChecker INSERT, Orchestrator UPDATE.
3. `log_task_state`는 CodeChecker INSERT, Lint UPDATE.
4. `log_agent_runs`는 각 컴포넌트가 자기 row만 INSERT/UPDATE.
5. Stage 3 (테스트) 실패 = 즉시 `final_verdict='FAIL'` 종료. 재시도 없음.
6. 재시도 최대 3회 (Stage 1·2 한정), 초과 시 FAIL.
7. LLM 호출은 CodeChecker / FE / BE만. Lint와 Orchestrator는 결정론적.

## 유지보수 — 스택 변경 체크리스트

FE 또는 BE의 기술 스택을 바꾸려면(예: FE → Phaser.js, BE → Spring Boot) 다음 **두 곳만** 수정하세요:

### 필수 (스택 정보의 단일 원천)
- [ ] **`lib/stack.config.json`** 의 해당 영역 블록
  - `displayName`, `install.command/checkPath`
  - `lint.{stage1,stage2,stage3}` — 정적분석/빌드/테스트 명령
    - `type: "command"` (`command: ["mvn", "compile"]` 등) 또는
    - `type: "node_check_recursive"` 같은 특수 핸들러 사용
  - `agent.{systemPromptHeader, moduleSystem, testFilePattern, testFramework, allowedDeps, stackSpecificRules}`
  - `snapshot.{extensions, rootGlob}` — Agent에게 보낼 파일 스냅샷 범위
  - `eslintConfig` (Java/Kotlin이면 `null`로 두고 lint stage1을 다른 도구로 교체)
- [ ] **`lib/stack_templates/<AREA>/`** placeholder 파일 일체
  - 예 Spring Boot: `pom.xml` (또는 `build.gradle`), `src/main/java/.../Application.java`, `src/test/java/.../HealthControllerTest.java` 등
  - bootstrap이 이 폴더를 그대로 `<AREA>/`에 복사

### 부수 (필요 시)
- [ ] **`rules/code_convention.md`** §6 테스트 도구 이름, §10 스택 일관성 (자연어로 정리)
- [ ] **`README.md`** 본 문서의 설치/실행 가이드

### 변경하지 않아도 되는 곳 (이게 핵심)
- ✅ `lib/bootstrap.js` — 템플릿 폴더만 보면 됨
- ✅ `agents/lint_agent.js` — stage type만 인식하면 됨
- ✅ `agents/be_agent.js` / `fe_agent.js` — 모든 스택 문구를 config에서 읽음
- ✅ `lib/stack.js` — 단순 로더

### 작업 순서 권장
1. `lib/stack_templates/<AREA>/` 폴더 내용 교체 (새 스택 placeholder)
2. `lib/stack.config.json` 의 `<AREA>` 블록 갱신
3. 기존 `<AREA>/` 폴더 통째로 삭제 (`rm -rf BE` 등)
4. `npm start` 실행 → bootstrap이 새 placeholder 깔고 의존성 설치 → CodeChecker → 새 스택 Agent → Lint
5. 첫 라운드 통과하면 마이그레이션 완료

### 한 곳 더 — 새 스택이 npm 기반이 아니면
- `package.json` 루트의 `scripts.lint:be`, `scripts.test:be` 같은 보조 스크립트는 npm 의존이라 의미 없어질 수 있음. 사용 안 하면 무시하거나 삭제.
- DB 비즈니스 코드는 여전히 `app_users` 테이블을 쓰므로 `db/schema.sql` 변경 불필요.

---

## 트러블슈팅

- **`Cannot find module '@anthropic-ai/sdk'`**: `npm install` 실행 필요.
- **MySQL 연결 실패**: `.env`의 DB 접속 정보, MySQL 서버 기동 여부 확인.
- **첫 실행 시 너무 오래 걸림**: FE/BE의 `npm install`이 처음에 한 번 돌기 때문. 이후엔 빠름.
- **Lint Stage 3에서 자꾸 FAIL**: 정책상 즉시 종료. 콘솔에 `task_id` 출력 → DB의 `log_task_state.stage_logs`에서 실패 상세 확인.
- **Windows 환경**: 모든 npm 자식 프로세스는 `shell: true`로 실행되며 path 구분자는 path.join으로 통일됨.
