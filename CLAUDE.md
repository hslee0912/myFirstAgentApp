# myFirstAgentApp

자연어 요구사항 → CodeChecker → BE/FE Agent → 3단계 Lint 게이트 → 자동 재시도 루프로 동작하는 멀티 에이전트 코드 생성 PoC. **Claude Code 같은 어시스턴트 없이 자율 동작**하는 게 목표.

## 파이프라인 (핵심 다이어그램)

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

## 절대 규칙 (위반 금지)

1. **폴더 격리** — BE Agent는 `BE/`만, FE Agent는 `FE/`만 수정. `validatePaths` 런타임 검증.
2. **보호 파일** (`stack.config.json` `protectedConfigFiles`) — Agent는 `package.json`, `vite.config.js`, `index.html`, `.eslintrc.json` 등을 절대 작성 못함. `validatePaths`가 차단.
3. **새 의존성 금지** — `allowedDeps`만 사용. 부족하면 `notes`에 사유만 적고 코드 만들지 말 것. 매니페스트 수정 금지.
4. **Placeholder 보존** (rules/common.md §8) — bootstrap이 깐 `server.test.js`/`App.test.jsx`는 그대로 유지. 새 코드가 거기에 맞춰야 함.
5. **dotenv override** — 모든 `dotenv.config()` 는 `{ override: true }`. (CLI inline override가 막히는 부작용 → 향후 변경 검토, [docs/ROADMAP.md](docs/ROADMAP.md))
6. **Stage 3 (테스트) 실패 = 즉시 FAIL** — 재시도 없음. Stage 1/2 실패만 최대 3회 재시도. (VALIDATION_MODE=on일 때만 적용 — off면 Phase 4 자체가 안 돌아감)
7. **파이프라인 자동 commit (`COMMIT_MODE`)** — `.env`의 `COMMIT_MODE`로 orchestrator의 자동 commit 여부 토글:
   - `COMMIT_MODE=auto` (기본) → verdict=PASS일 때 orchestrator가 `BE/`+`FE/`만 자동 commit. **push는 항상 사람이 수행**.
   - `COMMIT_MODE=manual` (또는 `auto`가 아닌 모든 값) → 자동 commit 안 함, 사람이 commit/push 모두 수행.
   - 사람의 `git commit`/`git push`는 어떤 모드에서도 검사·차단 없음.
   - 자동 commit 메시지 포맷: `auto: <task_id> — <user_request 첫 80자>`
8. **검증 토글 (`VALIDATION_MODE`)** — `.env`의 `VALIDATION_MODE`로 Phase 4 (Lint Agent) 실행 여부 토글:
   - `VALIDATION_MODE=on` (기본) → Phase 4 정상 실행 (eslint → build → tests).
   - `VALIDATION_MODE=off` (또는 `on`이 아닌 모든 값) → Phase 4 통째로 skip, `log_task_state`를 자동 SUCCESS 처리.
   - **안전장치(`validatePaths`, `protectedConfigFiles`)는 모드 무관 항상 켜짐**.
   - 의미: "결정론적 *검증*"만 끄고 "결정론적 *제어흐름*"은 유지 → LLM 출력 ablation/디버깅 모드.

## 사람·Claude 직접 편집 vs Agent 자동 생성

위 절대 규칙 #1, #2의 `validatePaths` 검증은 **LLM Agent가 코드를 응답으로 내놓을 때** 적용된다. 사람이 IDE로 직접 편집하거나, Claude(어시스턴트)가 Edit/Write 도구로 BE/, FE/, 또는 protected 파일을 수정하는 것은 **정상적인 개발 작업으로 허용**된다.

- Agent 산출물 → `validatePaths` 통과해야 디스크에 반영
- 사람·Claude 직접 편집 → 자유. commit/push 시점 검사·차단 없음.
- 자동 commit은 오직 **파이프라인이 만든 변경분(BE/+FE/)** 에만 적용.

## 문서 구조 (어디서 뭘 찾는가)

| 문서 | 내용 | 언제 읽나 |
|---|---|---|
| **CLAUDE.md** (이 파일) | 핵심 다이어그램·절대 규칙·라우팅 | 매 세션 자동 로드 |
| [docs/PRD.md](docs/PRD.md) | 비전, 목표, 비-목표, 스택 결정 | 프로젝트 의도 확인 시 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 컴포넌트, LLM 모델 해석, DB 스키마, verdict 의미, phase 상세 | 시스템 구조 파악 시 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 표준 명령, 모드 토글, 트러블슈팅, 자주 하는 작업 | 실행·디버깅 시 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 결정 타임라인 + 맥락 | "왜 이렇게 했지?" 궁금할 때 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 다음 작업 큐, 비-목표 | 다음 본격 작업 시작 시 |
| [rules/common.md](rules/common.md) | BE+FE 공통 코딩 규칙 | BE/FE Agent가 매 LLM 호출 시 자동 |
| [rules/be.md](rules/be.md) | BE 전용 (snake_case, CommonJS 등) | BE Agent가 매 호출 시 자동 |
| [rules/fe.md](rules/fe.md) | FE 전용 (PascalCase, ES Modules 등) | FE Agent가 매 호출 시 자동 |
| [README.md](README.md) | 사용자용 setup·실행 가이드 | 신규 환경 셋업 시 |

## 컨벤션 한 줄

- env 변수 추가/수정 시 `.env`와 `.env.example` **반드시 짝**으로 갱신. runtime은 `.env`를 읽고, `.env.example`은 신규 clone용 템플릿. 한쪽만 손보면 사용자가 토글하려 할 때 변수가 없어 혼란.

## 최근 결정 (3개만, 전체는 docs/DECISIONS.md)

- 2026-05-08  (TBD)    Prompt caching — BE/FE system prompt에 rules 포함 + cache_control:ephemeral. 재시도/같은 라운드 내 호출에서 ~90% 입력 비용 절감.
- 2026-05-08  5365d2d  문서 구조 분리 — CLAUDE.md 슬림화, docs/+rules/ 분산. BE/FE Agent prompt 다이어트.
- 2026-05-08  cff5842  Per-agent LLM 모델 분리 (CODECHECKER_MODEL/BE_AGENT_MODEL/FE_AGENT_MODEL)

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
