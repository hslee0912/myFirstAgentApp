# Operations

표준 명령, 정상 소요 시간, 자주 하는 작업, 트러블슈팅. 시스템 구조는 [ARCHITECTURE.md](ARCHITECTURE.md) 참조.

## 테스트·검증 워크트리 정책 (단일 재사용)

orchestrator·BE Agent·FE Agent를 돌리는 모든 실행은 **main 프로젝트 디렉터리에서 직접 돌리지 말 것**. 대신 다음 단일 워크트리를 사용:

- 경로: `.claude/worktrees/test/`
- 브랜치: `claude/test`

**처음 한 번 만들기** (이미 있으면 skip):
```bash
git worktree add .claude/worktrees/test -b claude/test
cp .env .claude/worktrees/test/.env
```

**그 이후 모든 실행은 같은 워크트리 재사용** — 매번 새 워크트리 만들지 말 것. 이유:
- `npm install` 캐시 절약 (FE 366 + BE 475 패키지를 매번 새로 깔지 않음)
- 디스크에 워크트리 누적 방지 (`finalize`, `verify-port-fix`, `deploy-check` 식으로 쌓이지 않음)
- stale docker 컨테이너 누적 방지 (Phase 7.5 teardown은 PASS일 때만 동작 — 새 워크트리는 새 compose project name이라 따로 teardown 안 됨)

**다음 사이클 사이 정리** (필요할 때만):
```bash
cd .claude/worktrees/test && rm -rf BE FE
# bootstrap이 fresh 템플릿 다시 깔아줌. node_modules는 보존 (재설치 불필요)
```

**별도 feature 브랜치가 정말 필요할 때**만 새 워크트리 만들기. 일반 검증·실험은 `test` 워크트리 하나로 충분.

`main` 프로젝트 디렉터리는 코드 편집·git history 관리용. orchestrator 실행 영역이 아님.

## 표준 명령

```bash
# DB 초기화 (CREATE DATABASE/TABLE — 처음 한 번)
#   db/agent_schema.sql 실행. 비즈니스 schema는 D33(2026-05-14, B-2 미구현)으로
#   Agent migration(BE/db/migrations/*.sql)을 통한 자동 적용 흐름으로 운영 예정.
#   B-2 구현 전까지는 비즈니스 테이블 없음 (D31 잠정 정책 유효).
npm run init-db

# DB 전체 reset — D32(2026-05-14): 모든 테이블 동적 DROP + db/*.sql 알파벳 순회.
#   현재는 db/agent_schema.sql 하나뿐이지만, db/business_schema.sql 같은 사람 정의
#   schema 파일을 추가하면 자동 함께 적용된다.
npm run reset-db

# 파이프라인 실행
npm start                                          # 기본 시나리오 (회원가입)
node agents/orchestrator.js "기능 요청 자연어..."   # 커스텀
# → verdict=PASS && COMMIT_MODE=auto면 종료 직전 BE/+FE/ 자동 commit (push 안 함)

# UI control panel (http://localhost:4000)
#   - prompt 입력 + Run 버튼 → orchestrator spawn (동시 1 run)
#   - 최근 task 목록 + 클릭하면 decision/states/runs 상세 (1.5초 polling)
#   - .env 토글 GUI editor (UI_EDITABLE_KEYS 화이트리스트만)
#   - reset-db / Stop containers / FE/BE 열기 (Deploy PASS 시)
#   - 시작 시 4개 포트(UI_PORT/DEPLOY_PORT_FE/BE/DB) 자동 정리:
#     · node.exe 좀비만 강제 종료 (KILLABLE)
#     · mysqld/postgres/docker daemon은 PROTECTED — 절대 안 건드림
#     · 그 외(unknown)·이미 죽은 socket(opaque)은 skip + 경고만
#   - 그래도 포트 충돌이면 자동 +1..+20 fallback (dual-stack probe)
npm run ui

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
| `DEPLOY_MODE` | `on` (기본) / `off` | Phase 8/9 (Deploy + PostTest) 실행 여부 |
| `DEPLOY_PORT_FE` / `_BE` / `_DB` | 5173 / 3001 / 3306 (기본) | Container expose 포트 (충돌 시 변경) |
| `DEPLOY_TIMEOUT_SEC` | 정수 (기본 300) | docker compose up 최대 대기 시간 |
| `POSTTEST_TIMEOUT_SEC` | 정수 (기본 60) | api_test.runContract 최대 시간 |
| `LOG_TAIL_LINES` | 정수 (기본 200) | docker logs 보존 줄 수 (FAIL 시 output_json) |
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

## Phase 8/9 (Deploy + PostTest)

### 사전 요구사항
- Docker Desktop (또는 docker compose v2/v1) 설치 + 실행 중. Docker 미설치 시 verdict=ERROR.
- 기존 DB 사용자: 한 번 ALTER 실행 필요 (아래 참조).
- `DEPLOY_MODE=off`면 Docker 불필요, Phase 8/9 자동 skip.

### 기존 DB 마이그레이션 (1회만)

`log_agent_runs.agent_name` ENUM에 `'Deploy'`, `'PostTest'` 추가:

```bash
mysql -u root -p myfirstagentapp_db -e "ALTER TABLE log_agent_runs MODIFY agent_name ENUM('Orchestrator','CodeChecker','FE','BE','Lint','Deploy','PostTest') NOT NULL;"
```

또는 MySQL Workbench 같은 GUI에서 SQL editor 사용. 신규 init은 `db/agent_schema.sql`이 알아서 적용.

### Deploy 끄고 Phase 1~5만 검증

`.env`에서 `DEPLOY_MODE=off` → Phase 8/9 통째 skip, verdict는 Phase 4까지로 결정.

### Deploy 실패 시 디버깅 (D6=B 시너지)

Phase 8/9가 FAIL이면 컨테이너가 보존됩니다. PASS여도 `DEPLOY_TEARDOWN_ON_PASS=off`로 보존 가능.

```bash
docker ps                                       # 살아있는 컨테이너 ID
docker logs --tail 1000 <container>             # 한 service 마지막 N줄
docker exec -it <mysql_container> mysql -uroot -proot myfirstagentapp_db   # DB 직접 접근

# 수동 cleanup (디버깅 끝나고)
docker compose --project-directory . -f lib/stack_templates/docker-compose.yml down --remove-orphans
# 또는 UI에서: 상세 패널의 "🛑 Stop containers" 버튼 (POST /api/stop-containers)
```

### Phase 7.5 teardown 토글 — `DEPLOY_TEARDOWN_ON_PASS`

기본 `on` — verdict=PASS면 즉시 `docker compose down`. 깨끗하지만 사용자가 배포된 FE/BE를 브라우저로 직접 볼 수 없음 (1초도 안 됨).

`off`로 토글하면 — PASS여도 컨테이너 보존. UI 상세 패널의 **🌐 FE 열기 / 🔌 BE 열기** 링크가 클릭 가능. 다 보고 나면 **🛑 Stop containers** 버튼으로 명시 종료. FAIL/ERROR는 정책 무관 항상 보존.

```
DEPLOY_TEARDOWN_ON_PASS=off   # .env 또는 UI 체크박스 (4번째 토글)
```

학생 시연 시 추천 조합: `DEPLOY_MODE=on` + `DEPLOY_TEARDOWN_ON_PASS=off` → 풀 사이클 끝나면 UI에서 한 클릭으로 실제 페이지 확인.

### Phase 8 pre-cleanup — 우리 컨테이너 광역 정리 (label + convention)

매 Phase 8 시작 시 `lib/container_cleanup.js`의 `cleanupOurContainers()`가 호출돼 **이 PoC가 만들어둔 모든 컨테이너**를 `docker rm -f`로 정리합니다. 그 후 port preflight가 동작하므로 — docker 누적 점유가 없어 **호스트 포트가 매 사이클 같은 값(5173/3001/3306)으로 잡힘**. UI의 "FE/BE 열기" 링크가 영구 유효.

**식별 기준 (2-tier)**:
1. **Label** — compose가 만든 새 컨테이너는 `com.myfirstagentapp.managed=true` 라벨 (docker-compose.yml에 정의). 이게 매칭되면 무조건 victim.
2. **Convention (legacy)** — 옛 라벨 없는 컨테이너용. **이름 패턴 + image 둘 다 매칭**해야 victim:
   - FE:    `*-fe-<n>$` AND image endsWith `-fe`
   - BE:    `*-be-<n>$` AND image endsWith `-be`
   - MySQL: `*-mysql-<n>$` AND image startsWith `mysql:`

**false-positive 방지** (단위 테스트로 보호됨, `tests/container_cleanup.test.js` 36 케이스):
- 누가 nginx 컨테이너를 `nginx-fe-1`로 이름 지어도 image 매칭 안 돼 안 죽임
- 사용자의 standalone `mysql:8` 컨테이너는 이름 패턴 다르면 안 죽임
- postgres / redis / jenkins 등 무관한 컨테이너 모두 보존

**Log 예시**:
```
[deploy] pre-cleanup: sweeping managed + legacy containers
[deploy] cleanup: removing 6 stale container(s)
  - finalize-fe-1 (finalize-fe) via convention
  - finalize-be-1 (finalize-be) via convention
  - verify-port-fix-mysql-1 (mysql:8) via convention
  ...
```

수동 정리 (테스트 외 일반 사용):
```powershell
# 모두 죽이고 정리
docker ps -a --format '{{.ID}}' --filter "label=com.myfirstagentapp.managed=true" | %{ docker rm -f $_ }
docker network prune -f
```

### 포트 충돌 시 — 자동 fallback (2-layer 검출)

학생 환경에서 5173/3001/3306 충돌 흔함 (특히 호스트에 이미 MySQL 돌고 있거나, 이전 FAIL 사이클의 컨테이너가 D6=B 정책으로 보존돼 있을 때). Phase 8 시작 직전에 deploy_agent가 두 layer로 host 포트 가용성을 검증하고 충돌 시 자동으로 `+1, +2, ...` (최대 +20)에서 빈 포트로 fallback한다.

**두 layer 모두 통과해야 free로 판정**:
1. **Docker layer** — `docker ps --format '{{.Ports}}'` 파싱해 출판된 host 포트 Set 작성. 이전 FAIL 사이클이 남긴 컨테이너가 점유한 포트를 미리 skip. Docker CLI 부재 시 빈 Set 반환 — graceful degrade.
2. **OS layer** — `net.createServer().listen(port, '0.0.0.0')` probe. 호스트 MySQL / 다른 process 등 non-docker 충돌 검출.

```
[deploy] port 3306 (mysql) is in use — falling back to 3307. Set DEPLOY_PORT_DB=3307 in .env to persist.
[deploy] resolved ports: mysql=3307 be=3001 fe=5173 (requested mysql=3306 be=3001 fe=5173)
```

- 자동 fallback은 `process.env`만 갱신 (Phase 8 compose substitution + Phase 9 PostTest baseUrl 모두 새 값 사용).
- `.env` 파일은 그대로 둠 (single source of truth 정책). console hint 보고 사용자가 명시적으로 영구 설정하려면 `.env` 직접 편집.
- 컨테이너 *내부* 포트는 그대로 (3306/3001/5173) — 호스트 매핑만 바뀜.
- 20번 시도 후에도 빈 포트 못 찾으면 `failed_stage='port_preflight'` 로 즉시 FAIL.
- 디버깅: `docker ps --format 'table {{.Names}}\t{{.Ports}}'` + `netstat -ano | findstr :3306` (Windows) / `ss -tlnp | grep :3306` (Linux).

수동 강제 설정 (예: 항상 3307 쓰고 싶을 때):
```
DEPLOY_PORT_DB=3307
```
