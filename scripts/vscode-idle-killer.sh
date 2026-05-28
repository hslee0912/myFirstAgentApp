#!/usr/bin/env bash
# vscode-idle-killer.sh — VSCode server N분 활동 없으면 자동 종료.
#
# 배경:
# 사용자가 local VSCode를 닫아도 EC2의 vscode-server (~/.vscode-server/cli/servers/...)는
# init(PPID=1)에 detach된 상태라 *살아남음*. SSH 연결만 끊겨도 안 죽음.
# 매번 ~1.4 GB RAM 점유 → cycle OOM 위험 증가 (D87/D88 메모 참조).
#
# 검출 방법:
# VSCode server는 활동 시 `~/.vscode-server/data/logs/*/exthost*/*.log` 등에 *주기적
# 갱신*. 사용자가 disconnect하면 log file mtime이 멈춤. *가장 최근 mtime* 이 N분 전이면
# vscode-server kill. TCP socket 검사가 안 통하는 이유: VSCode는 unix socket 통신.
#
# 사용 (수동):
#   bash scripts/vscode-idle-killer.sh           # 검사 + 임계 도달 시 kill
#   IDLE_THRESHOLD=300 bash ...                  # 임계 5분 (default 900s = 15분)
#   DRY_RUN=1 bash ...                           # 검사만, kill 안 함
#
# 사용 (자동, cron):
#   crontab 등록 — 5분 간격:
#     */5 * * * * /home/ubuntu/myFirstAgentApp/.claude/worktrees/test/scripts/vscode-idle-killer.sh >>/tmp/vscode-idle-killer.log 2>&1
#   (scripts/install-vscode-cron.sh가 idempotent로 등록)

set -u

IDLE_THRESHOLD="${IDLE_THRESHOLD:-900}"  # 15분 (초)
DRY_RUN="${DRY_RUN:-0}"
VSCODE_DIR="$HOME/.vscode-server"

# vscode-server 떠있나?
if ! pgrep -f ".vscode-server/cli/servers" >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] vscode-server not running — exit 0"
  exit 0
fi

# 가장 최근 활동 mtime (log + state 파일)
LATEST_MTIME=$(find "$VSCODE_DIR" -type f \
  \( -name "*.log" -o -name "state.vscdb" -o -name "*.json" \) \
  -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)

if [ -z "$LATEST_MTIME" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] cannot measure mtime — exit 0"
  exit 0
fi

NOW=$(date +%s)
IDLE=$((NOW - LATEST_MTIME))

echo "[$(date '+%Y-%m-%d %H:%M:%S')] idle=${IDLE}s  threshold=${IDLE_THRESHOLD}s"

if [ "$IDLE" -lt "$IDLE_THRESHOLD" ]; then
  echo "  → active (no kill)"
  exit 0
fi

# 임계 도달 — kill 또는 dry-run 보고
PIDS=$(pgrep -f ".vscode-server/cli/servers")
PID_COUNT=$(echo "$PIDS" | wc -w)

if [ "$DRY_RUN" = "1" ]; then
  echo "  → DRY_RUN: would SIGTERM ${PID_COUNT} pids: $PIDS"
  exit 0
fi

echo "  → SIGTERM to ${PID_COUNT} vscode-server pids"
# shellcheck disable=SC2086
kill -TERM $PIDS 2>/dev/null || true
sleep 3
LEFT=$(pgrep -f ".vscode-server/cli/servers" || true)
if [ -n "$LEFT" ]; then
  echo "  → SIGKILL fallback (still alive): $LEFT"
  # shellcheck disable=SC2086
  kill -9 $LEFT 2>/dev/null || true
fi
echo "  ✅ vscode-server cleanup done"
logger "vscode-idle-killer: cleanup (idle ${IDLE}s ≥ ${IDLE_THRESHOLD}s)"
