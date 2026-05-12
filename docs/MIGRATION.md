# EC2 마이그레이션 가이드

로컬 Windows 환경의 myFirstAgentApp을 EC2 (Linux)로 이식하는 정식 절차.

## 이식 가능성 요약

| 항목 | 이식 가능? | 자동화? |
|---|---|---|
| 프로젝트 코드 (git tracked) | ✓ 100% | `git clone` |
| `.env` (secret 포함) | ✓ 수동 | `.env.example` 템플릿 → 사람이 값 채움 |
| Claude Code 메모리 | ✓ ~95% | `scripts/migrate-to-ec2.sh`가 tar 생성 |
| Conversation history (JSONL) | ✓ ~90% | 같은 스크립트로 옵션 포함 |
| 도구 인프라 (MySQL, Docker) | ✓ EC2에 설치 | 사람이 직접 |

이번 세션의 D29(단일 host MySQL) + PUBLIC_HOST + Vite proxy + extra_hosts(host-gateway) 작업 덕분에 *코드 변경은 0*. `.env`의 두세 줄만 EC2 값으로 갱신하면 그대로 작동.

## 사전 준비 (EC2)

```bash
# 1. EC2 인스턴스 (Ubuntu 22.04 LTS 권장, t3.medium 이상)
# 2. Security Group:
#    - 22 (SSH) — 본인 IP만
#    - 5173 (FE) — 외부 노출 원하면. 안 그러면 SSH 터널링
#    - 3001 (BE) — 보통 노출 불필요 (FE proxy로 처리)
#    - 3306 (MySQL) — 외부 노출 절대 X (인스턴스 내부 통신만)

# 3. 패키지 설치
sudo apt update
sudo apt install -y nodejs npm mysql-server docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # docker sudo 없이 사용 (재로그인 필요)

# 4. Claude Code 설치
npm install -g @anthropic-ai/claude-code
```

## 단계별 이식 절차

### Step 1 — 로컬에서 이식 패키지 생성

Windows 로컬 (Git Bash 또는 WSL)에서:

```bash
cd C:\Users\SSAFY\myFirstAgentApp\.claude\worktrees\test
bash scripts/migrate-to-ec2.sh                     # memory만 (가장 보수적)
bash scripts/migrate-to-ec2.sh --with-sessions     # + 현재 워크트리의 대화 이력 (JSONL)
bash scripts/migrate-to-ec2.sh --include-env       # + .env (secret 포함 — 안전한 채널로만 전송)
```

스크립트 결과:
- `./migration-bundle.tar.gz` 생성
- EC2에서 실행할 명령 안내가 콘솔에 출력됨

**미묘한 점 — 어느 워크트리에서 실행하느냐**:
Claude Code는 워크트리마다 별도 폴더에 대화 이력을 저장한다 (`.claude/projects/<root>--claude-worktrees-<name>/`). 그래서 `--with-sessions`는 *현재 실행 워크트리의 이력만* 포함. 다른 워크트리의 세션도 옮기고 싶으면 *그 워크트리에서* 스크립트를 다시 실행해 별도 번들을 만들거나, 둘 다 tar에 묶어서 한 번에 옮기면 됨. 메모리(`memory/` 폴더)는 *project root에 단일 저장*되므로 어디서 실행하든 동일.

### Step 2 — EC2로 전송

```bash
# 로컬에서
scp migration-bundle.tar.gz ubuntu@<ec2-public-dns>:/tmp/

# EC2에서
ssh ubuntu@<ec2-public-dns>
```

### Step 3 — EC2에서 프로젝트 셋업

```bash
# EC2에서
cd ~
git clone https://github.com/hslee0912/myFirstAgentApp.git
cd myFirstAgentApp

# 단일 재사용 test 워크트리 정책 (docs/OPERATIONS.md)
git worktree add .claude/worktrees/test -b claude/test

cd .claude/worktrees/test
cp .env.example .env
# .env 편집 — 다음 라인만 변경:
#   ANTHROPIC_API_KEY=<key>
#   DB_PASSWORD=<EC2 MySQL password>
#   PUBLIC_HOST=<EC2 public DNS>   (예: ec2-1-2-3-4.compute.amazonaws.com)
#   DB_HOST=host.docker.internal   ← 그대로 (변경 X)
nano .env
```

### Step 4 — EC2 MySQL 셋업

```bash
# 호스트 MySQL 비밀번호 + bind-address + user host 설정
sudo mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '<password>';"
sudo mysql -uroot -p<password> -e "CREATE USER 'root'@'%' IDENTIFIED BY '<password>'; GRANT ALL ON *.* TO 'root'@'%'; FLUSH PRIVILEGES;"

# bind-address 0.0.0.0 또는 주석 처리 — docker bridge에서 접근 허용
sudo sed -i 's/^bind-address.*/bind-address = 0.0.0.0/' /etc/mysql/mysql.conf.d/mysqld.cnf
sudo systemctl restart mysql

# Schema 시드
mysql -uroot -p<password> < db/agent_schema.sql
```

### Step 5 — Claude Code 메모리/세션 복원

```bash
# EC2에서 — 1) Claude Code 프로젝트 폴더가 어떻게 인코딩되는지 확인:
claude --print "exit"   # 한 번 실행해서 폴더 생성
ls ~/.claude/projects/
# → 예: -home-ubuntu-myFirstAgentApp-.claude-worktrees-test/

# 2) tar 내용 복원
tar -xzf /tmp/migration-bundle.tar.gz -C /tmp/
ls /tmp/migration-bundle/
# memory/ + (옵션) <session-id>.jsonl

# 3) 적절한 폴더로 이동
EC2_PROJECT_DIR=$(ls ~/.claude/projects/ | grep myFirstAgentApp | head -1)
cp -r /tmp/migration-bundle/memory ~/.claude/projects/$EC2_PROJECT_DIR/
cp /tmp/migration-bundle/*.jsonl ~/.claude/projects/$EC2_PROJECT_DIR/ 2>/dev/null || true
```

### Step 6 — 의존성 + 첫 부팅

```bash
cd ~/myFirstAgentApp/.claude/worktrees/test
npm install   # 도구 의존성

# (선택) 도구 도구 검증
npm run init-db      # schema 재시드 (idempotent)
npm run test         # 단위 테스트

# Claude Code 시작
claude
# 또는 UI 직접 띄움
npm run ui:test      # main 디렉터리에서 동작 — 위로 가서: cd ~/myFirstAgentApp && npm run ui:test
```

### Step 7 — 검증

```bash
# 1. UI 서버 — 메모리/PUBLIC_HOST가 반영됐는지
curl -s http://localhost:4000/api/env | python3 -m json.tool | grep PUBLIC_HOST

# 2. Docker compose — 새 deploy_agent의 host.docker.internal이 동작하는지
cd ~/myFirstAgentApp/.claude/worktrees/test
docker compose --project-directory . -f lib/stack_templates/docker-compose.yml up --build -d --wait
docker compose --project-directory . -f lib/stack_templates/docker-compose.yml ps

# 3. BE health check (BE → host MySQL via host.docker.internal)
#    회원가입 smoke test는 D31(2026-05-13) app_users 폐기로 제거. 다음 cycle
#    에서 spec이 요구하면 BE Agent가 새 핸들러를 in-memory로 만든다.
curl -s http://localhost:3001/health
#    → {"success":true,"data":{"status":"ok"}}

# 4. host MySQL에 Agent 도구 테이블이 시드됐는지
mysql -uroot -p<password> myfirstagentapp_db -e "SHOW TABLES;"
#    → log_agent_runs, log_agent_decisions, log_task_state

# 5. (Claude Code 세션 복원 검증)
claude /resume   # 옛 세션 목록 보임 → 선택
```

## 자동 작동하는 부분 (이번 세션 작업의 효과)

| 패턴 | 어디서 결정됐나 | EC2 동작 |
|---|---|---|
| `host.docker.internal` (BE → host MySQL) | `lib/stack_templates/docker-compose.yml`의 `extra_hosts: host-gateway` | ✓ Linux native docker에서 자동 alias |
| `PUBLIC_HOST` (FE/BE 링크) | `.env` + `ui/server.js`의 `<meta name="public-host">` 주입 | ✓ EC2 public DNS 박으면 끝 |
| Vite proxy (`/api/*` → BE 컨테이너) | `FE/vite.config.js` + compose의 `VITE_BE_PROXY_TARGET` | ✓ |
| 단일 host MySQL (D29) | docker-compose.yml에 mysql 서비스 없음 | ✓ host MySQL 직결 |

## 사람이 처리해야 할 부분

| 항목 | 사유 |
|---|---|
| `.env`의 secret (API key, DB password) | git ignored. 수동 복사 또는 EC2 Secrets Manager |
| host MySQL 설치 + schema 시드 | EC2에 직접 설치 |
| Docker 설치 | EC2에 직접 설치 |
| Security Group / Firewall | 사람 결정 사항 (외부 노출 범위) |
| EC2 인스턴스 백업 정책 | RDS 안 쓰면 EBS 스냅샷 등 |

## 트러블슈팅

| 증상 | 원인 / 처리 |
|---|---|
| BE 컨테이너 부팅 후 `Access denied (using password: ...)` | EC2 MySQL의 `root@%` 사용자 없음. Step 4의 CREATE USER 명령 재확인 |
| BE 컨테이너에서 `ECONNREFUSED host.docker.internal` | EC2 MySQL bind-address가 `127.0.0.1`. Step 4의 sed 명령으로 `0.0.0.0`. systemctl restart 빠뜨림 |
| FE에서 "네트워크 오류" 회원가입 실패 | Vite proxy 미동작. `VITE_BE_PROXY_TARGET=http://be:3001` env가 compose에 주입됐는지 확인 |
| 브라우저에서 외부 접근 불가 | EC2 Security Group 5173 inbound rule 없음 또는 잘못된 source |
| Claude Code 메모리 안 보임 | 폴더명 인코딩 mismatch. `ls ~/.claude/projects/`로 정확한 폴더명 확인 후 거기로 이동 |
| `/resume` 시 세션 없음 | JSONL 파일이 올바른 폴더에 없음. Step 5 재확인 |

## EC2 → 다른 환경으로 (역방향)

같은 절차의 역방향. memory 폴더 + JSONL을 tar로 묶고 다른 머신으로. Anthropic API가 stateless라 *어디서든* 재개 가능.

## 향후 후보 (현 단계엔 미포함)

- **CI/CD 자동화** — GitHub Actions로 EC2 배포 자동화
- **RDS 마이그레이션** — `DB_HOST=<RDS endpoint>` 한 줄 변경. 자세한 RDS 셋업 절차는 별도 가이드 필요 시 작성
- **Reverse proxy** — Nginx로 5173/3001을 80/443에 노출 + TLS
- **PM2 / systemd** — Claude Code 또는 UI 서버를 daemon으로
