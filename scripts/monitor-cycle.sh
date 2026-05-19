#!/usr/bin/env bash
# Cycle 실시간 모니터 — log_agent_runs / log_task_state / docker container 폴링.
#
# 사용법:
#   bash scripts/monitor-cycle.sh                # 최신 task_id 자동 감지
#   bash scripts/monitor-cycle.sh task_2026...   # 특정 task
#   npm run monitor                              # 동일
#   mon                                          # ~/.bashrc alias
#
# 종료: Ctrl+C. Orchestrator status가 RUNNING 외 (SUCCESS/FAILED/ERROR)로
# 바뀌면 자동 종료.
set -e

TASK="${1:-}"

# DB 비번 .env에서 읽기 (script 디렉터리 기준)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
[ ! -f "$ENV_FILE" ] && { echo "[monitor] .env 없음: $ENV_FILE"; exit 1; }
DB_PASS=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
DB_NAME=$(grep '^DB_NAME=' "$ENV_FILE" | cut -d= -f2-)
DB_NAME="${DB_NAME:-myfirstagentapp_db}"

MYSQL() { mysql -uroot -p"$DB_PASS" "$DB_NAME" "$@" 2>/dev/null | grep -v 'Warning'; }

# 최신 task 자동 감지
if [ -z "$TASK" ]; then
  TASK=$(MYSQL -N -e "SELECT task_id FROM log_agent_runs ORDER BY id DESC LIMIT 1;")
fi
[ -z "$TASK" ] && { echo "[monitor] task_id 없음 — cycle 시작 후 다시"; exit 1; }

echo "[monitor] task=$TASK   (Ctrl+C로 종료)"
sleep 1

trap 'echo ""; echo "[monitor] stopped by user"; exit 0' INT TERM

# TERM 환경 없는 nohup/subshell에서도 동작하도록 clear 대신 ANSI escape.
clear_screen() { printf '\033[2J\033[H'; }

while true; do
  clear_screen
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  cycle monitor — task=$TASK"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  echo "▶ log_agent_runs"
  MYSQL -e "
    SELECT id, agent_name, status,
           LEFT(IFNULL(started_at,''),19) AS started,
           LEFT(IFNULL(ended_at,'(running)'),19) AS ended,
           TIMESTAMPDIFF(SECOND, started_at, IFNULL(ended_at, NOW())) AS sec
    FROM log_agent_runs WHERE task_id='$TASK' ORDER BY id;"
  echo ""

  echo "▶ log_task_state (per area)"
  MYSQL -e "
    SELECT target, status, retry_count, failed_stage,
           LEFT(IFNULL(updated_at,''),19) AS updated
    FROM log_task_state
    WHERE decision_id IN (SELECT id FROM log_agent_decisions WHERE task_id='$TASK')
    ORDER BY id;"
  echo ""

  echo "▶ docker container (managed=myFirstAgentApp)"
  docker ps -a --filter 'label=com.myfirstagentapp.managed=true' \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -6
  echo ""

  echo "▶ docker image (myfirstagentapp_*)"
  docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null \
    | head -1
  docker images --format '{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null \
    | grep -i 'myfirstagentapp\|<none>' | head -4
  echo ""

  # Orchestrator 종료 감지 — RUNNING 외 status면 자동 종료
  ORCH=$(MYSQL -N -e "SELECT status FROM log_agent_runs WHERE task_id='$TASK' AND agent_name='Orchestrator' LIMIT 1;")
  if [ -n "$ORCH" ] && [ "$ORCH" != "RUNNING" ]; then
    echo "━━━ Orchestrator $ORCH — cycle 종료 ━━━"
    break
  fi

  sleep 5
done
