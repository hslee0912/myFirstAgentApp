# Product Requirements — myFirstAgentApp

## Vision

자연어 요구사항을 받아, 멀티 에이전트 시스템이 직접 코드를 작성하고 자체 검증한 뒤 결과물을 확정하는 토이 PoC. **Claude Code 같은 인터랙티브 어시스턴트 없이 완전 자율 동작**하는 게 핵심.

## Scope (목표)

- 자연어 prompt → CodeChecker가 BE/FE/BOTH 분류
- BE/FE Agent가 각자 영역 코드 + 단위 테스트 작성
- Lint Agent가 ESLint → Build → Tests 3단계 결정론적 검증
- verdict=PASS면 코드 디스크에 떨어지고 (옵션) 자동 commit
- 실패 시 fix_instructions 들고 자동 재시도 루프

## Non-Goals (이번 PoC에서 다루지 않음)

- 프로덕션 운영 (모니터링, 스케일링, SLA)
- 멀티 사용자·멀티 테넌트
- 인증·인가·요금제
- 멀티 프로젝트 동시 생성 (단일 프로젝트 PoC)
- UI (별도 phase에서 검토 — `ROADMAP.md` 참조)
- 배포 자동화 (별도 phase)

## 기술 스택 (확정 — 변경 없음)

| 영역 | 스택 | 이유 |
|---|---|---|
| BE | Express + bcrypt + mysql2 + Jest + Supertest | Node 생태계 단일화, 빠른 PoC |
| FE | Vite + React 18 + Vitest + RTL (jsdom) | 동일 |
| DB | MySQL (단일 instance, `myfirstagentapp_db`) | 비즈니스+에이전트 로그 한 곳 |
| LLM | Anthropic API (`@anthropic-ai/sdk`) | Agent별 모델 분리 가능 |

스택 교체 절차는 [ARCHITECTURE.md](ARCHITECTURE.md)와 [README.md](../README.md) 참조.

## 핵심 설계 원칙

1. **결정론과 LLM의 분리** — 시스템 결정은 100% Agent(LLM)에서, 운용·검증·제어는 결정론.
2. **폴더 격리** — BE Agent는 `BE/`만, FE Agent는 `FE/`만. `validatePaths` 런타임 검증.
3. **단일 원천** — 스택 정보는 `lib/stack.config.json` 하나, 컨벤션은 `rules/*.md`.
4. **기록 우선** — 모든 task는 DB(`log_agent_runs`, `log_agent_decisions`, `log_task_state`)에 기록. 디버깅 시 DB만 보면 진단 가능.
5. **사용자 책임 vs Agent 자동화 명확 구분** — 사람의 직접 commit/push는 자유, 파이프라인 산출물만 게이트 적용.

## 향후 방향 (요약)

- **다음 우선순위**: Deploy + Post-deploy Test phase 추가 (자율 검증 루프 완결)
- **그 다음**: UI 추가 (Express + 정적 HTML 또는 Vite/React)
- **더 후순위**: 멀티 프로젝트 생성기, DB provisioning 자동화, EC2 이전, prompt caching 최적화

자세한 큐는 [ROADMAP.md](ROADMAP.md) 참조.
