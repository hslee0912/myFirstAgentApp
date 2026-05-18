#!/usr/bin/env bash
# ============================================================================
# transfer-to-ec2.sh — 로컬 메모리/세션/.env를 EC2로 한 번에 자동 운반
#
# 두 단계를 묶어 일괄 자동화:
#   1. (로컬) migrate-to-ec2.sh — 메모리 + 세션 + .env 를 tar.gz 번들로 패키징
#   2. (전송) scp — 번들 + ec2-setup.sh 를 EC2 ~/ 로 업로드
#   3. (원격) ssh + ec2-setup.sh — EC2에서 의존성 설치 + git clone + npm ci +
#               .env 셋업 + 번들 풀기까지 일괄 실행
#
# 옮겨지는 것:
#   - ~/.claude/projects/<encoded>/memory/*.md   (Claude 대화 메모리)
#   - ~/.claude/projects/<encoded>/*.jsonl       (대화 세션 이력, 옵션)
#   - .env                                       (Anthropic API key 등, 옵션)
#   - 프로젝트 코드의 .md 문서 (docs/*.md, rules/*.md, CLAUDE.md, README.md 등)
#     → 이건 git tracked이라 EC2에서 git clone으로 자동 포함됨. 별도 운반 X.
#
# 사용법:
#   bash scripts/transfer-to-ec2.sh <ec2_user@host> <repo_url>
#   bash scripts/transfer-to-ec2.sh ubuntu@ec2-1-2-3-4.compute.amazonaws.com \
#        https://github.com/hslee0912/myFirstAgentApp.git
#
# 환경 변수 (옵션):
#   SSH_KEY=~/.ssh/my-ec2-key.pem        # SSH key 지정 시
#   INCLUDE_ENV=0|1   (default 1)        # .env 포함 여부
#   WITH_SESSIONS=0|1 (default 1)        # JSONL 세션 이력 포함 여부
#
# ⚠ 사전 조건:
#   - EC2에 SSH 접속 가능 (보안 그룹 22 열림, 키 등록됨)
#   - EC2 인스턴스 OS: Ubuntu 22.04+ 또는 Amazon Linux 2023
#   - 로컬에서 scripts/migrate-to-ec2.sh + scripts/ec2-setup.sh 사용 가능 (이 repo)
# ============================================================================
set -euo pipefail

EC2_HOST="${1:-}"
REPO_URL="${2:-}"

if [[ -z "$EC2_HOST" || -z "$REPO_URL" ]]; then
  grep '^#' "$0" | head -35
  echo
  echo "Error: 인자 부족."
  echo "       bash scripts/transfer-to-ec2.sh <ec2_user@host> <repo_url>"
  exit 1
fi

INCLUDE_ENV="${INCLUDE_ENV:-1}"
WITH_SESSIONS="${WITH_SESSIONS:-1}"
SSH_KEY="${SSH_KEY:-}"

SSH_OPTS=()
SCP_OPTS=()
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=("-i" "$SSH_KEY")
  SCP_OPTS+=("-i" "$SSH_KEY")
fi
# Disable strict host key check on first run (선택) — 보안 신경 쓰면 주석 처리
SSH_OPTS+=("-o" "StrictHostKeyChecking=accept-new")
SCP_OPTS+=("-o" "StrictHostKeyChecking=accept-new")

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_PATH="$REPO_ROOT/migration-bundle.tar.gz"

log()  { echo -e "\n\033[1;36m[transfer]\033[0m $*"; }
ok()   { echo -e "  \033[1;32m✓\033[0m $*"; }
err()  { echo -e "  \033[1;31m✗\033[0m $*" >&2; exit 1; }

# --- 1. 로컬에서 번들 생성 ---
log "1/4 로컬 번들 생성"
MIGRATE_ARGS=()
[[ "$WITH_SESSIONS" == "1" ]] && MIGRATE_ARGS+=("--with-sessions")
[[ "$INCLUDE_ENV"   == "1" ]] && MIGRATE_ARGS+=("--include-env")
MIGRATE_ARGS+=("--output" "$BUNDLE_PATH")

bash "$REPO_ROOT/scripts/migrate-to-ec2.sh" "${MIGRATE_ARGS[@]}"

if [[ ! -f "$BUNDLE_PATH" ]]; then
  err "번들 생성 실패: $BUNDLE_PATH 없음"
fi
ok "번들: $BUNDLE_PATH ($(du -h "$BUNDLE_PATH" | cut -f1))"

# --- 2. SSH 연결 확인 ---
log "2/4 SSH 연결 확인 ($EC2_HOST)"
if ! ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$EC2_HOST" "echo connected" 2>&1 | grep -q connected; then
  err "SSH 접속 실패. 다음 확인:\n  - Security Group inbound 22 본인 IP 허용\n  - SSH key 등록 (SSH_KEY=~/.ssh/key.pem)\n  - EC2 인스턴스 running 상태"
fi
ok "SSH 접속 OK"

# --- 3. scp로 번들 + ec2-setup.sh 전송 ---
log "3/4 scp 전송 (번들 + ec2-setup.sh)"
scp "${SCP_OPTS[@]}" "$BUNDLE_PATH" "$EC2_HOST:~/migration-bundle.tar.gz"
ok "번들 전송 완료"
scp "${SCP_OPTS[@]}" "$REPO_ROOT/scripts/ec2-setup.sh" "$EC2_HOST:~/ec2-setup.sh"
ok "ec2-setup.sh 전송 완료"

# --- 4. EC2에서 ec2-setup.sh 실행 (-t로 stdin prompt 활성화) ---
log "4/4 EC2 셋업 시작 (메모리/세션 복원 + git clone + npm ci + .env 셋업)"
echo "    ec2-setup.sh가 prompt할 항목:"
echo "      - MySQL root 비밀번호"
echo "      - ANTHROPIC_API_KEY (sk-ant-...)"
echo "      - PUBLIC_HOST (EC2 public DNS)"
echo "      - git user.email / user.name"
echo
ssh -t "${SSH_OPTS[@]}" "$EC2_HOST" \
  "chmod +x ~/ec2-setup.sh && bash ~/ec2-setup.sh '$REPO_URL' --bundle ~/migration-bundle.tar.gz"

echo
echo -e "\033[1;32m=============================================="
echo -e "EC2 운반 + 셋업 완료"
echo -e "==============================================\033[0m"
echo
echo "  다음 단계:"
echo "  1. AWS Console: Security Group inbound 5173 (또는 SSH 터널링)"
echo "  2. EC2 ssh 접속 후:"
echo "       cd ~/myFirstAgentApp/.claude/worktrees/test"
echo "       npm run ui"
echo "  3. 브라우저 http://<EC2_DNS>:4000 또는 SSH 터널:"
echo "       ssh -L 4000:localhost:4000 -L 5173:localhost:5173 $EC2_HOST"
echo "       → http://localhost:4000"
echo
echo "  로컬 번들 파일은 그대로 유지됩니다: $BUNDLE_PATH"
echo "  (삭제 원하면: rm \"$BUNDLE_PATH\")"
