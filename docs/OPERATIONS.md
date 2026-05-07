# Operations

표준 명령, 정상 소요 시간, 자주 하는 작업, 트러블슈팅. 시스템 구조는 [ARCHITECTURE.md](ARCHITECTURE.md) 참조.

## 표준 명령

```bash
# DB 초기화
npm run init-db

# 파이프라인 실행
npm start                                          # 기본 시나리오 (회원가입)
node agents/orchestrator.js "기능 요청 자연어..."   # 커스텀
# → verdict=PASS && COMMIT_MODE=auto면 종료 직전 BE/+FE/ 자동 commit (push 안 함)

# 검증 끄고 빠르게 LLM 원시 출력만 보고 싶을 때 (ablation)
# 주의: dotenv override:true 정책으로 CLI inline override는 무시됨.
#       반드시 .env에서 VALIDATION_MODE=off 토글 후 실행.

# 개별 테스트 실행
cd BE && npx jest --runInBand
cd FE && npx vitest run
```

## 모드 토글 (.env 편집이 유일한 방법)

| 변수 | 값 | 효과 |
|---|---|---|
| `COMMIT_MODE` | `auto` (기본) / `manual` | PASS 시 자동 commit 여부 |
| `VALIDATION_MODE` | `on` (기본) / `off` | Phase 4 Lint 실행 여부 |
| `CODECHECKER_MODEL` / `BE_AGENT_MODEL` / `FE_AGENT_MODEL` | 모델명 또는 빈 값 | Agent별 모델 (빈 값이면 ANTHROPIC_MODEL fallback) |
| `MAX_RETRIES` | 정수 (기본 3) | retry_count 한계 |
| `LLM_INTER_CALL_MS` | ms (기본 15000) | BE↔FE 사이 쿨다운 |
| `LLM_INTER_ROUND_MS` | ms (기본 30000) | 라운드 간 쿨다운 |

## 정상 소요 시간

Orchestrator end-to-end 한 번에 약 **3~5분**:
- CodeChecker ~30s
- BE Agent ~60–90s
- (BE↔FE 사이 15s 쿨다운, rate limit 회피)
- FE Agent ~60–90s
- Lint Agent ~30s × 영역
- (재시도 라운드면 라운드 사이 30s 쿨다운 추가)

VALIDATION_MODE=off면 Lint 단계 사라져서 ~1~2분 단축.

5분 이상 멈춘 듯 보여도 정상일 수 있음 — `tail -f /tmp/orchestrator_*.log` 또는 `log_agent_runs` 조회로 진행 상태 확인.

## 자주 하는 작업

### 새 기능 추가
1. `node agents/orchestrator.js "..."` — 파이프라인이 end-to-end로 돌아감.
2. `COMMIT_MODE=auto`(기본)이면 PASS 시 `BE/`+`FE/`가 자동 commit됨 (로컬에만).
3. 사람이 변경 내용 확인 후 `git push` (검사·차단 없음).

### 실패한 실행 진단
1. 콘솔의 `task_id` 확인.
2. `log_agent_runs WHERE task_id=...` 조회 → 어느 Agent가 실패했는지.
3. LLM JSON 깨졌으면 raw 응답이 `os.tmpdir()/llm-bad-response-*.txt`에 덤프됨.
4. `log_task_state`의 `failed_stage`, `fix_instructions`, `stage_logs` 확인.

### Phase 7 자동 commit 진단
verdict=PASS인데 commit이 생기지 않았을 때 콘솔 로그를 확인. 자동 commit이 skip되는 모든 경우:

| 케이스 | 콘솔 메시지 | 대응 |
|---|---|---|
| `COMMIT_MODE` ≠ `auto` | `[commit] COMMIT_MODE=... — auto-commit skipped` | `.env`에서 `COMMIT_MODE=auto`로 |
| git repo 아님 | `[commit] not a git repository — auto-commit skipped` | `git init` 후 재실행 |
| BE/FE 둘 다 없음 | `[commit] neither BE/ nor FE/ exists — auto-commit skipped` | bootstrap 확인 |
| BE/FE에 변경 0 | `[commit] no changes in BE/ or FE/ — auto-commit skipped` | 정상 (Agent가 실제 코드 수정 안 함) |
| `git add` 실패 | `[commit] git add failed: ...` | 권한·잠금 등 OS 문제 |
| `git commit` 실패 | `[commit] git commit failed: ...` | git config user.name/email, pre-commit hook 등 |

자동 commit 실패는 verdict에 영향을 주지 않음 — verdict는 PASS 그대로, commit만 안 만들어짐.

### 스택 교체
[README.md](../README.md)의 "스택 변경 체크리스트" 섹션 참조.

## 트러블슈팅

- **`Cannot find module '@anthropic-ai/sdk'`**: `npm install` 실행 필요.
- **MySQL 연결 실패**: `.env`의 DB 접속 정보, MySQL 서버 기동 여부 확인.
- **첫 실행 시 너무 오래 걸림**: FE/BE의 `npm install`이 처음에 한 번 돌기 때문. 이후엔 빠름.
- **Lint Stage 3에서 자꾸 FAIL**: 정책상 즉시 종료. 콘솔에 `task_id` 출력 → DB의 `log_task_state.stage_logs`에서 실패 상세 확인.
- **Windows 환경**: 모든 npm 자식 프로세스는 `shell: true`로 실행되며 path 구분자는 path.join으로 통일됨.
- **CLI inline env override가 안 먹힘**: `dotenv.config({ override: true })` 정책 때문. `.env` 직접 편집이 유일한 방법. 향후 변경 검토는 [ROADMAP.md](ROADMAP.md) 참조.
