# Roadmap

다음 작업 큐. 우선순위 순서.

## 1순위 — 다음 본격 작업

### [A] Deploy + Post-deploy Test (Phase 8 / Phase 9)

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

## 2순위 — UI

[A]가 동작 검증되면 UI 추가. 현재 CLI orchestrator를 백그라운드로 spawn하고 진행 상태를 폴링·표시.

가능한 구현:
- Express + 정적 HTML/JS (가장 단순, ~200줄)
- Vite + React 18 (이미 스택에 있음, 외관 좋음)

UI에서 토글할 항목: 사용자 prompt, COMMIT_MODE, VALIDATION_MODE, 모델 선택. 진행 중인 task의 phase/state 실시간 표시. 종료 시 verdict 보여주고 디스크 변경분 diff 표시.

## 더 후순위 — 당분간 안 건드림

### [C] dotenv override 정책 변경 (UI 단계 진입 시 같이)

`lib/db.js`와 `agents/orchestrator.js`의 `dotenv.config({ override: true })`가 **CLI inline env 주입을 모두 무력화**한다 (PowerShell `$env:`, Git Bash `VAR=value cmd`, child_process.spawn의 env 모두). 모드 토글하려면 `.env` 직접 편집이 유일한 방법.

**Why:** 원래 목적은 시스템 env에 빈 `ANTHROPIC_API_KEY`가 있을 때 .env 값으로 덮기 위함. 그러나 부작용으로 모든 env 변수의 inline override가 막힘.

**옵션** (UI 단계 진입 시):
- (A) UI가 .env를 매 요청 직전 재작성 후 spawn (hacky)
- (B) **추천** — `dotenv.config({ override: false })`로 변경 + `ANTHROPIC_API_KEY`만 별도 가드. UI는 `child_process.spawn(..., { env: { ...process.env, MODE_VAR: '...' } })`로 자연스럽게 토글 가능.
- (C) orchestrator를 모듈 함수화 (가장 깔끔하지만 리팩토링 큼)

CLAUDE.md의 절대 규칙 #5 ("dotenv override")도 그때 조정 필요.

또한 OPERATIONS.md의 `VALIDATION_MODE=off node ...` 같은 CLI inline 예시도 **현재 미작동**이므로 .env 편집 방식으로 docs 정정 필요.

### 멀티 프로젝트 생성기

`prompt + project_name + path` 입력 → 새 프로젝트 생성. 현재 단일 프로젝트(자기 자신을 키움) 구조에서 본격 리팩토링 필요. Agent의 `BE/`/`FE/` 상대경로를 파라미터화. 도구 repo와 생성 repo 분리.

### DB provisioning 자동화

생성된 프로젝트마다 자기 DB. `CREATE DATABASE <name>_db` 자동 실행 (MySQL root 권한 필요).

### EC2 이전

코드 자체는 거의 그대로 옮겨감. 환경 셋업이 작업 대부분 (~1~2일). UI 단계 직후 또는 Phase D 배포와 묶어서.

### 자동 commit 적용 (생성된 프로젝트 repo에)

현재 자동 commit은 도구 repo 자체에 동작. 멀티 프로젝트로 가면 생성된 프로젝트의 repo에 commit해야 함.

## 확인된 비-목표 (2026-05-08)

- **Max 구독으로 자동화 LLM 호출 비용 회피** — 불가능. Anthropic 정책 (2026-04 확정): 인터랙티브만 구독 quota, 프로그래밍 호출은 모두 API key + per-token 청구. `claude -p` headless도 `ANTHROPIC_API_KEY` 필요. Claude Agent SDK도 구독 OAuth 명시적 거부.
- **다중 LLM provider (OpenAI, Gemini)** — 가능하지만 단일 provider로 PoC 충분. 5~7시간 작업이라 가성비 낮음. 진짜 필요해질 때 (rate limit·vendor lock-in 회피 필요 등) 도입.

## 완료된 작업

- 2026-05-08 [B] **VALIDATION_MODE 토글** (commit `c6417ac`).
- 2026-05-08 **Per-agent LLM 모델 분리** (commit `cff5842`).
- 2026-05-07 **COMMIT_MODE 도입 + pre-push gate 제거** (commit `b6212e1`).
- 그 외 — `DECISIONS.md` 참조.
