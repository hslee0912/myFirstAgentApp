#!/usr/bin/env bash
# ============================================================================
# ec2-setup.sh — 신규 EC2 인스턴스 (Ubuntu 22.04+ / Amazon Linux 2023) 에서
# myFirstAgentApp을 처음부터 실행 가능한 상태로 셋업.
#
# 전제:
#   - 새 EC2 인스턴스에 SSH 접속 완료 (ubuntu / ec2-user 등 sudo 가능 계정)
#   - GitHub repo URL 알고 있음
#   - Anthropic API key, MySQL root 비밀번호 준비
#
# 사용법:
#   curl -fsSL <raw url of this script> -o ec2-setup.sh
#   chmod +x ec2-setup.sh
#   ./ec2-setup.sh <repo_url>
#
#   또는 git clone 후:
#   bash scripts/ec2-setup.sh
#
# 단계:
#   1. OS 감지 + 의존성 install (Node 20, MySQL, Docker, lsof, dos2unix, git)
#   2. Docker group 가입 (재로그인 필요 안내)
#   3. MySQL 서비스 시작 + bind-address=0.0.0.0 + root@% user + agent_schema seed
#   4. git clone (이미 있으면 skip) + worktree add claude/test
#   5. CRLF → LF 변환 (dos2unix) + chmod +x scripts/*.sh
#   6. npm ci 3곳 (root, BE, FE) — Linux native bcrypt 빌드
#   7. .env 셋업 — .env.example 복사 + 3개 secret prompt
#   8. git config user.name/email (orchestrator auto-commit용)
#   9. (선택) migrate-to-ec2.sh 번들 풀기 (--bundle 인자)
#   10. 검증: npm test (398 passing)
#
# Security Group 안내 (별도 AWS Console 작업 필요):
#   - 22 inbound (SSH, 본인 IP만)
#   - 5173 inbound (FE 데모, 0.0.0.0/0 또는 본인 IP)
#   - 3306, 3001은 외부 비공개
# ============================================================================
set -euo pipefail

REPO_URL="${1:-}"
BUNDLE_PATH=""
PROJECT_DIR="$HOME/myFirstAgentApp"

# --- argument parsing ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE_PATH="$2"; shift 2 ;;
    --dir) PROJECT_DIR="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | head -50
      exit 0
      ;;
    *) REPO_URL="$1"; shift ;;
  esac
done

log() { echo -e "\n\033[1;36m[ec2-setup]\033[0m $*"; }
ok()  { echo -e "  \033[1;32m✓\033[0m $*"; }
warn(){ echo -e "  \033[1;33m⚠\033[0m $*"; }
err() { echo -e "  \033[1;31m✗\033[0m $*" >&2; exit 1; }

# --- 0. require sudo ---
if [[ $EUID -eq 0 ]]; then err "root로 직접 실행하지 마세요. 일반 user + sudo로 실행."; fi
sudo -v || err "sudo 권한 필요"

# --- 1. OS detect ---
log "1. OS 감지"
if   [[ -f /etc/lsb-release ]];   then OS=ubuntu; PM="apt-get"
elif [[ -f /etc/system-release ]];then OS=al2023; PM="dnf"
else err "지원 OS 아님 (Ubuntu/Amazon Linux 2023만)"; fi
ok "OS=$OS  package manager=$PM"

# --- 2. install dependencies ---
log "2. 의존성 install (Node 20 / MySQL / Docker / lsof / dos2unix / git)"
if [[ $OS == ubuntu ]]; then
  sudo apt-get update -y
  # Node 20 (NodeSource)
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  sudo apt-get install -y mysql-server docker.io docker-compose-plugin lsof dos2unix git curl
else
  sudo dnf update -y
  sudo dnf install -y nodejs20 mariadb105-server docker lsof dos2unix git curl
  # docker compose plugin은 amazon linux에선 별도 — pip 또는 plugin path
  if ! docker compose version >/dev/null 2>&1; then
    sudo mkdir -p /usr/local/lib/docker/cli-plugins
    sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
fi
ok "node=$(node -v)  npm=$(npm -v)  docker=$(docker --version | cut -d, -f1)"

# --- 3. docker group ---
log "3. Docker group 가입"
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  warn "재로그인 필요: \`exit\` 후 다시 ssh 접속 → 이 스크립트 재실행"
  warn "또는 \`newgrp docker\` 한 후 계속 (이 shell 한정)"
fi
sudo systemctl enable --now docker || true
ok "docker daemon up"

# --- 4. MySQL setup ---
log "4. MySQL setup"
sudo systemctl enable --now mysql 2>/dev/null || sudo systemctl enable --now mariadb 2>/dev/null || true
# bind-address 0.0.0.0 — BE container가 host.docker.internal로 접근
MY_CNF=$(find /etc/mysql /etc/my.cnf.d /etc -maxdepth 3 -name '*.cnf' 2>/dev/null | xargs grep -l 'bind-address' 2>/dev/null | head -1 || true)
if [[ -n "$MY_CNF" ]]; then
  sudo sed -i 's/^bind-address.*/bind-address = 0.0.0.0/' "$MY_CNF" || true
  sudo systemctl restart mysql 2>/dev/null || sudo systemctl restart mariadb 2>/dev/null || true
  ok "bind-address=0.0.0.0 적용 → $MY_CNF"
else
  warn "bind-address 설정 파일 못 찾음. 수동 확인: sudo grep -r bind-address /etc/mysql /etc/my.cnf*"
fi

# secret prompt
read -rsp "  MySQL root 비밀번호 (현재 또는 새로 설정할 값): " MYSQL_ROOT_PW
echo
DB_NAME="myfirstagentapp_db"

# 시도 1: 패스워드 있는 상태 / 시도 2: 빈 패스워드 (fresh install)
mysql_try() {
  mysql -uroot -p"$MYSQL_ROOT_PW" -e "$1" 2>/dev/null || \
  sudo mysql -uroot -e "$1" 2>/dev/null
}
mysql_try "CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
  && ok "DB '${DB_NAME}' ready" || warn "DB 생성 실패 — 수동 확인 필요"
mysql_try "CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '${MYSQL_ROOT_PW}'; GRANT ALL ON *.* TO 'root'@'%'; FLUSH PRIVILEGES;" \
  && ok "root@% user ready" || warn "root@% 생성 실패 — 이미 있거나 권한 부족"

# --- 5. git clone or skip ---
log "5. 프로젝트 clone / 위치 확인"
if [[ -d "$PROJECT_DIR/.git" ]]; then
  ok "이미 clone됨: $PROJECT_DIR"
  cd "$PROJECT_DIR"
elif [[ -n "$REPO_URL" ]]; then
  git clone "$REPO_URL" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
  ok "clone 완료: $PROJECT_DIR"
else
  err "PROJECT_DIR ($PROJECT_DIR) 비어있고 REPO_URL 없음. 사용법: $0 <repo_url>"
fi

# --- 6. line endings + permissions ---
log "6. CRLF → LF + chmod +x"
find scripts -name '*.sh' -exec dos2unix {} + 2>/dev/null || true
chmod +x scripts/*.sh
ok "scripts/*.sh ready"

# --- 7. npm ci 3곳 (Linux native build) ---
log "7. npm ci — root + BE + FE (bcrypt Linux 빌드 강제)"
for d in . BE FE; do
  if [[ -f "$d/package-lock.json" ]]; then
    (cd "$d" && rm -rf node_modules && npm ci --no-audit --no-fund --loglevel=error)
    ok "$d/node_modules 새로 빌드 완료"
  else
    warn "$d/package-lock.json 없음 — skip (cycle 시 bootstrap이 처리)"
  fi
done

# --- 8. .env setup ---
log "8. .env 셋업"
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok ".env.example → .env 복사"

  read -rsp "  ANTHROPIC_API_KEY (sk-ant-...): " ANTHROPIC_API_KEY; echo
  read -rp  "  PUBLIC_HOST (EC2 public DNS, 예: ec2-1-2-3-4.compute.amazonaws.com): " PUBLIC_HOST

  # 안전 update — 라인 자체 교체
  sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}|" .env
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${MYSQL_ROOT_PW}|" .env
  sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${PUBLIC_HOST}|" .env

  ok ".env 3개 변수 (ANTHROPIC_API_KEY / DB_PASSWORD / PUBLIC_HOST) 셋업 완료"
else
  ok ".env 이미 존재 — skip (수정 원하면 vim .env)"
fi

# --- 9. worktree add ---
log "9. claude/test worktree 셋업"
if [[ ! -d .claude/worktrees/test ]]; then
  git worktree add .claude/worktrees/test -b claude/test || git worktree add .claude/worktrees/test claude/test
  ok "worktree ready: .claude/worktrees/test"
else
  ok "worktree 이미 존재"
fi

# worktree의 .env도 동일 복사
cp .env .claude/worktrees/test/.env
ok "test worktree .env sync"

# --- 10. DB schema seed ---
log "10. DB schema seed (agent_schema.sql)"
if [[ -f db/agent_schema.sql ]]; then
  mysql -uroot -p"$MYSQL_ROOT_PW" "$DB_NAME" < db/agent_schema.sql 2>/dev/null \
    && ok "agent_schema.sql applied" \
    || warn "schema apply 실패 — 수동 확인: mysql -uroot -p $DB_NAME < db/agent_schema.sql"
fi

# --- 11. git config (auto-commit용) ---
log "11. git config user (auto-commit 용)"
if ! git config --global user.email >/dev/null 2>&1; then
  read -rp "  git user.email: " GIT_EMAIL
  read -rp "  git user.name: " GIT_NAME
  git config --global user.email "$GIT_EMAIL"
  git config --global user.name "$GIT_NAME"
fi
ok "git user $(git config --global user.email)"

# --- 12. bundle restore (선택) ---
if [[ -n "$BUNDLE_PATH" && -f "$BUNDLE_PATH" ]]; then
  log "12. migrate-to-ec2.sh 번들 풀기"
  tar xzf "$BUNDLE_PATH" -C "$HOME"
  ok "번들 복원 완료 (~/.claude/projects/...)"
fi

# --- 13. 검증 ---
log "13. 검증 — npm test"
cd "$PROJECT_DIR/.claude/worktrees/test"
if npm test 2>&1 | tail -3 | grep -q "pass 398"; then
  ok "398/398 PASS — 셋업 성공"
else
  warn "npm test 실패 — 로그 확인 필요"
fi

# --- 마무리 ---
echo
echo -e "\033[1;32m=============================================="
echo -e "EC2 셋업 완료"
echo -e "==============================================\033[0m"
echo
echo "  다음 단계:"
echo "  1. AWS Console에서 Security Group inbound 22(SSH) + 5173(FE) 추가"
echo "  2. cd $PROJECT_DIR/.claude/worktrees/test"
echo "  3. npm run ui  →  브라우저로 http://${PUBLIC_HOST:-<EC2 IP>}:4000 접속"
echo "  4. (또는 dev) node agents/orchestrator.js --file=tmp_big_prompt_run.txt"
echo
echo "  ⚠ Docker group은 재로그인 후 적용. 'exit' 후 다시 ssh 접속 권장."
echo
