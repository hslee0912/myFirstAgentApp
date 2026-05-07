# Decision Log

시간순 결정 기록. 최근 3개는 [CLAUDE.md](../CLAUDE.md)에도 미러.

## 2026-05-08

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
