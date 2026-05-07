# Roadmap

다음 작업 큐. 우선순위 순서. **잠금된 5단계 시퀀스**로 진행.

```
[A] Deploy/Test → UI (+Observability) → [E] Tool use → [F] MCP → 멀티 프로젝트 → end-state
```

이 시퀀스 끝나면 학생 시연용 **3대 AI Agent 패턴**이 같은 프로젝트에 모임:
1. **Pipeline pattern** (메인) — Phase 1~9
2. **Tool use loop pattern** (대조군) — BE Agent의 alternate mode
3. **MCP integration** (확장성) — 표준 프로토콜로 도구 layer 갈아끼우기

## 1순위 — [A] Deploy + Post-deploy Test (Phase 8 / Phase 9)

자율 검증 루프의 마지막 한 조각. `prompt → 코드 → 빌드 → 테스트 → 배포 → 배포 후 테스트` 풀 사이클을 CLI에서 닫는다. 단일 프로젝트 구조 유지, 멀티 프로젝트 리팩토링은 안 함.

**잠금된 설계 결정 (2026-05-08 사용자 승인):**
- 배포 구현 = **결정론 템플릿** (LLM 안 씀, `lib/stack_templates/`에 docker-compose.yml 추가)
- 배포 타겟 = **로컬 docker-compose** (FE+BE+MySQL 한 묶음)
- 테스트 구현 = **결정론** (Phase 1 CodeChecker가 만든 `api_contract` 직접 활용)
- 테스트 깊이 = **API contract schema 검증** (단순 200 확인이 아니라 request/response shape까지)
- verdict 통합 = **Deploy/Test 실패 = verdict=FAIL** (테스트까지 통과해야 PASS)

**구현 시 짚을 부수 항목**:
- docker-compose down 자동화 정책
- 포트 충돌(5173/3001/3306) 시 빈 포트 탐색 여부
- Docker 미설치 환경 fallback
- MySQL volume mount
- 테스트 실패 시 docker logs를 stage_logs에 보존

## 2순위 — UI (+ Observability)

[A]가 동작 검증되면 UI 추가. **Observability를 UI scope의 일부로 명시** (별도 phase 아님).

**프레임워크**: Express + 정적 HTML/JS 추천 (~200줄, 단순). Vite + React도 가능 (외관 좋음).

**UI 기능 (단일 control panel)**:
- Prompt 입력 + 모드 토글 (COMMIT_MODE, VALIDATION_MODE, BE_AGENT_MODE [E 단계 후], 모델 선택)
- 진행 상태 + 타임라인 (Phase 1→9 시각화)
- Agent별 token·비용 통계
- 재시도 체인 시각화 (round 1 fix_instructions → round 2 결과)
- Cache hit/miss 표시 (이미 console에 있는 정보를 UI로)
- 결과물 diff·파일 트리

**Real-time update**: DB 1~2초 polling으로 충분 (SSE/WebSocket 불필요).

**의존성**: [C] dotenv override 정책 변경을 함께 진행 (UI가 spawn하는 자식에 env 주입하려면 필수).

## 3순위 — [E] Tool use loop pattern (시연 대조군)

**핵심 가치**: 학생에게 *Pipeline 패턴 vs Tool use 패턴* 직접 비교 시연. 같은 코드 생성 작업을 두 방식으로 풀어보고 차이 토의.

**구현 방향**:
- Anthropic SDK의 `tools` 파라미터 + `tool_use_id` 응답 처리
- BE Agent에 env 토글: `BE_AGENT_MODE=oneshot|tool_use` (기본 `oneshot`, 기존 동작 그대로)
- tool_use 모드: agent loop → LLM이 도구 선택 → 실행 → 결과 → 다음 → "done" 결정
- **도구 세트 (1차)**: `list_files(path)`, `read_file(path)`, `write_file(path, content)`, `run_test()`, `done(notes)`
- **FE Agent는 그대로 oneshot 유지** (정체성 보존, 시연 시 비교 명확)

**보안 가드**: `write_file` 도구 호출에 **기존 `validatePaths` 가드 적용 필수** — Agent가 BE/ 영역 침범 못 하도록.

**시연 시나리오**:
1. 같은 prompt를 두 모드로 실행
2. log_agent_runs에 두 task_id 비교 — 호출 수, 토큰, 시간, 결과물 차이
3. 토론: 어느 패턴이 어느 상황에 적합?

**주의**: 비용·시간 ↑ (호출 여러 번). 학생 시연용으론 OK, production 자동화엔 trade-off 따짐.

**작업량**: ~150~200 LOC, 3~4시간.

## 4순위 — [F] MCP integration

**핵심 가치**: [E]의 in-house 도구 레이어를 **표준 프로토콜(MCP)** 로 외부화하는 진화 과정 시연. 학생에게 "도구 추상화 → 표준화 → 생태계" 흐름 직관.

**구현 방향**:
- `@modelcontextprotocol/sdk` (Node.js MCP 클라이언트)
- 첫 MCP 서버: **filesystem MCP** (`@modelcontextprotocol/server-filesystem` — Anthropic 공식 reference, 가장 쉬움)
- BE Agent의 도구 호출이 내부 함수 → MCP 클라이언트 호출로 갈음
- **path scoping 필수**: filesystem MCP `--allowed-directories <BE 절대경로>` 옵션으로 격리
- 추후 추가 후보: sqlite MCP (DB 접근), git MCP (commit·diff)

**시연 시나리오**:
- "[E]의 read_file은 내가 직접 짠 거. [F]에서는 Anthropic·커뮤니티가 만든 MCP 서버를 그대로 사용. 같은 Agent가 도구 출처만 바꿈."
- MCP 서버를 갈아끼워서 같은 Agent에 다른 능력 부여 가능 시연
- UI에서 MCP 서버 상태(running/stopped/connected) 보여주는 게 자연스러움

**의존성**: [E] 완료 후 진입 (도구 레이어 있어야 외부화 의미 있음).

**작업량**: ~250~400 LOC, 5~7시간.

## 5순위 — 멀티 프로젝트 생성기 (end-state)

UI에서 "새 프로젝트 만들기" 가능. `prompt + project_name + path` 입력 → 새 디렉토리에 새 DB까지 자동 생성.

**필요 변경**:
- Agent의 `BE/`/`FE/` 상대경로를 **파라미터화** (가장 큰 리팩토링)
- 도구 repo (myFirstAgentApp)와 생성 repo의 **구조적 분리**
- 프로젝트 registry (UI에서 목록·전환·삭제)
- DB provisioning 자동화 (`CREATE DATABASE <name>_db`, MySQL root 권한 필요)
- 동시 실행 정책 — 한 번에 1개 큐 권장 (rate limit·자원 회피)

**의존성**: 앞의 모든 단계가 단일 프로젝트 가정. 5순위에서 그 가정 풀림.

## 알려진 이슈 / 부수 작업

### [C] dotenv override 정책 변경 (UI 단계 진입 시 함께)

`lib/db.js`와 `agents/orchestrator.js`의 `dotenv.config({ override: true })`가 **CLI inline env 주입을 모두 무력화**한다 (PowerShell `$env:`, Git Bash `VAR=value cmd`, child_process.spawn의 env 모두). 모드 토글하려면 `.env` 직접 편집이 유일한 방법.

**Why:** 원래 목적은 시스템 env에 빈 `ANTHROPIC_API_KEY`가 있을 때 .env 값으로 덮기 위함. 그러나 부작용으로 모든 env 변수의 inline override가 막힘.

**옵션** (UI 단계 진입 시):
- (A) UI가 .env를 매 요청 직전 재작성 후 spawn (hacky)
- (B) **추천** — `dotenv.config({ override: false })`로 변경 + `ANTHROPIC_API_KEY`만 별도 가드. UI는 `child_process.spawn(..., { env: { ...process.env, MODE_VAR: '...' } })`로 자연스럽게 토글 가능.
- (C) orchestrator를 모듈 함수화 (가장 깔끔하지만 리팩토링 큼)

CLAUDE.md의 절대 규칙 #5 ("dotenv override")도 그때 조정 필요. OPERATIONS.md의 CLI inline 예시도 정정 필요.

### [D] 다중 LLM provider 지원 (미래 작업 큐)

OpenAI(ChatGPT), Google Gemini 연동. 가능하나 작업량 ~290 LOC / 5~7h라 후순위.

**도입 트리거 4개 중 하나 충족 시 검토**:
1. Anthropic rate limit이 자주 걸려 병목
2. 벤더 lock-in 회피 needs 부상
3. 특정 Agent에 다른 모델 family가 더 적합 판단
4. Ablation 연구: "어느 provider가 BE/FE 코드 생성 잘 하는가" 측정

**구현 방향 (이미 합의된 그림)**:
```
lib/providers/
├── anthropic.js   # 현재 lib/llm.js 래핑
├── openai.js
└── google.js
```

`.env` 패턴: `LLM_PROVIDER`, `<AGENT>_PROVIDER`, `<AGENT>_MODEL`.

**기존 자산**: `lib/llm.js`의 callJSON 추상화가 이미 있어 — provider abstraction 추가는 깨끗.

### EC2 이전

코드 자체는 거의 그대로 옮겨감. 환경 셋업이 작업 대부분 (~1~2일). UI 단계 직후 또는 멀티 프로젝트와 묶어서.

### 자동 commit 적용 (생성된 프로젝트 repo에)

현재 자동 commit은 도구 repo 자체에 동작. 멀티 프로젝트로 가면 생성된 프로젝트의 repo에 commit해야 함.

## 확인된 비-목표 (2026-05-08)

- **Max 구독으로 자동화 LLM 호출 비용 회피** — 불가능. Anthropic 정책 (2026-04 확정): 인터랙티브만 구독 quota, 프로그래밍 호출은 모두 API key + per-token 청구. `claude -p` headless도 `ANTHROPIC_API_KEY` 필요. Claude Agent SDK도 구독 OAuth 명시적 거부.
- **LangGraph·LangChain·CrewAI 등 agent framework 도입** — 핵심 가치 명제 ("framework 없이 design")와 정면 충돌. Claude Code 바이브 코딩으로 직접 설계하는 것이 이 프로젝트의 정체성.

## 완료된 작업

- 2026-05-08 **문서 구조 분리** (commit `5365d2d`, `ffa5d59`).
- 2026-05-08 **Prompt caching** (commit `ffa5d59`).
- 2026-05-08 [B] **VALIDATION_MODE 토글** (commit `c6417ac`).
- 2026-05-08 **Per-agent LLM 모델 분리** (commit `cff5842`).
- 2026-05-07 **COMMIT_MODE 도입 + pre-push gate 제거** (commit `b6212e1`).
- 그 외 — `DECISIONS.md` 참조.
