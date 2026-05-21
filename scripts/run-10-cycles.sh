#!/usr/bin/env bash
# 10회 cycle 자동 실행 — UI API (Init + Run Pipeline) 시뮬.
#
# ⚠️ 핵심: 우리 fix는 push 안 함 (사용자 명시). InitProject가 매번
# `git reset --hard origin/main`으로 ahead 변경 폐기 → 매 cycle 직전에
# /tmp/myapp-fix/* 에서 worktree로 복원해야 우리 fix가 살아남는다.
#
# 결과: /tmp/10cycles_results.tsv (cycle별 verdict + duration)
# 진행: /tmp/10cycles.log (실행 로그)

set -e

N_CYCLES=${N_CYCLES:-10}
COOLDOWN_BETWEEN_CYCLES=${COOLDOWN_BETWEEN_CYCLES:-30}
PROJECT_DIR="/home/ubuntu/myFirstAgentApp/.claude/worktrees/test"
ENV_FILE="$PROJECT_DIR/.env"
FIX_DIR="/tmp/myapp-fix"
DB_PASS=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
RESULTS="/tmp/10cycles_results.tsv"
MAX_CYCLE_WAIT=${MAX_CYCLE_WAIT:-2400}

cd "$PROJECT_DIR"

MYSQL() { mysql -uroot -p"$DB_PASS" myfirstagentapp_db "$@" 2>/dev/null | grep -v 'Warning'; }

# restore — InitProject의 git reset --hard 후 우리 fix 다시 적용
restore_fixes() {
  if [ ! -d "$FIX_DIR" ]; then
    echo "  ⚠️ $FIX_DIR 없음 — fix restore skip"
    return
  fi
  cp "$FIX_DIR/codechecker_agent.js" agents/codechecker_agent.js
  cp "$FIX_DIR/be_agent.js"          agents/be_agent.js
  cp "$FIX_DIR/fe_agent.js"          agents/fe_agent.js
  cp "$FIX_DIR/orchestrator.js"      agents/orchestrator.js
  cp "$FIX_DIR/lint_agent.js"        agents/lint_agent.js
  cp "$FIX_DIR/spec_sync_agent.js"   agents/spec_sync_agent.js
  cp "$FIX_DIR/llm.js"               lib/llm.js
  cp "$FIX_DIR/stack.config.json"    lib/stack.config.json
  cp "$FIX_DIR/spec_sync.js"         lib/spec_sync.js
  # D97 (2026-05-21): placeholder 필드 인벤토리 자동 추출기. fe_agent.js가 require.
  [ -f "$FIX_DIR/placeholder_inventory.js" ] && cp "$FIX_DIR/placeholder_inventory.js" lib/placeholder_inventory.js
  # D97-bis (2026-05-21): placeholder 사용 검사 (필수 식별자 미참조 catch).
  [ -f "$FIX_DIR/placeholder_usage_check.js" ] && cp "$FIX_DIR/placeholder_usage_check.js" lib/placeholder_usage_check.js
  mkdir -p lib/stack_templates/BE/src && cp "$FIX_DIR/validators.js" lib/stack_templates/BE/src/validators.js
  # D94 (2026-05-21): FE 게임 상수 placeholder 복원 (결정론 가드)
  mkdir -p lib/stack_templates/FE/src/constants && [ -f "$FIX_DIR/game.js" ] && cp "$FIX_DIR/game.js" lib/stack_templates/FE/src/constants/game.js
  [ -f "$FIX_DIR/.env.example" ] && cp "$FIX_DIR/.env.example" .env.example
  cp "$FIX_DIR/domain.md"            rules/domain.md
  cp "$FIX_DIR/agent_schema.sql"     db/agent_schema.sql
  cp "$FIX_DIR/spec_sync.test.js"    tests/spec_sync.test.js
  cp "$FIX_DIR/agent_prompts.test.js" tests/agent_prompts.test.js
  cp "$FIX_DIR/package.json"         package.json
  mkdir -p .vscode && [ -f "$FIX_DIR/vscode_settings.json" ] && cp "$FIX_DIR/vscode_settings.json" .vscode/settings.json
  # D93 (2026-05-20): docker-compose.yml에 subnet 172.20.0.0/16 고정 (random subnet 회피)
  [ -f "$FIX_DIR/docker-compose.yml" ] && cp "$FIX_DIR/docker-compose.yml" lib/stack_templates/docker-compose.yml
  # D89: InitProject가 DB를 origin/main의 agent_schema.sql로 reset해 SpecSync ENUM이 사라짐 →
  #   매 cycle 시작 시 ENUM ALTER 다시 적용. 빈 테이블이라 즉시 완료.
  if [ -f .env ]; then
    set -a; source .env; set +a
    MYSQL_PWD="${DB_PASSWORD}" mysql -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -u "${DB_USER:-root}" "${DB_NAME:-myFirstAgentApp}" -e "
      ALTER TABLE log_agent_runs MODIFY agent_name ENUM('Orchestrator','CodeChecker','FE','BE','Lint','Migration','ContractSync','SpecSync','Deploy','PostTest') NOT NULL;
      ALTER TABLE log_task_state MODIFY failed_stage ENUM('STAGE1','STAGE2','STAGE3','MIGRATION','CONTRACT_SYNC','SPEC_SYNC','AGENT_GUARD') NULL;
    " 2>/dev/null && echo "  ✓ DB ENUM (SpecSync/SPEC_SYNC) re-applied"
  fi
  echo "  ✓ fix files restored from $FIX_DIR (incl. SpecSync + validators placeholder)"
}

# results header
if [ ! -f "$RESULTS" ]; then
  printf "cycle\ttask_id\tstart_at\tend_at\tduration_s\tverdict\tphase_summary\n" > "$RESULTS"
fi

# prompt body (1회) — PROMPT_FILE env로 다른 명세서 사용 가능 (default: tmp_big_prompt_run.txt)
PROMPT_FILE="${PROMPT_FILE:-tmp_big_prompt_run.txt}"
echo "  📄 PROMPT_FILE = $PROMPT_FILE"
PROMPT_FILE="$PROMPT_FILE" node -e "
const fs = require('fs');
fs.writeFileSync('/tmp/run-body.json', JSON.stringify({ prompt: fs.readFileSync(process.env.PROMPT_FILE,'utf8') }));
"

for i in $(seq 1 "$N_CYCLES"); do
  echo "════════════════════════════════════════════════"
  echo "  Cycle $i / $N_CYCLES   start at $(date '+%H:%M:%S')"
  echo "════════════════════════════════════════════════"

  # [1] InitProject (BE/src + FE/src 삭제 + DB log reset + git reset --hard)
  INIT=$(curl -s -X POST http://localhost/api/init -H 'Content-Type: application/json' -d '{}')
  INIT_OK=$(echo "$INIT" | node -e "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ try { const j=JSON.parse(s); console.log('ok='+j.ok+' be_src='+j.be_src_deleted+' fe_src='+j.fe_src_deleted); } catch(_){ console.log(s.slice(0,200)); }})")
  echo "[$i] Init: $INIT_OK"

  # [2] fix restore (git reset --hard로 폐기된 우리 변경 복원)
  restore_fixes

  # [3] Run Pipeline — orchestrator spawn 시점에 file에서 fix 코드 load
  RUN=$(curl -s -X POST http://localhost/api/run -H 'Content-Type: application/json' --data @/tmp/run-body.json)
  echo "[$i] Run: $RUN"

  sleep 4
  TASK=$(MYSQL -N -e "SELECT task_id FROM log_agent_runs ORDER BY id DESC LIMIT 1;")
  START_AT=$(MYSQL -N -e "SELECT started_at FROM log_agent_runs WHERE task_id='$TASK' AND agent_name='Orchestrator';")
  echo "[$i] task_id=$TASK  started=$START_AT"

  # [4] polling
  T0=$(date +%s)
  while true; do
    ORCH=$(MYSQL -N -e "SELECT status FROM log_agent_runs WHERE task_id='$TASK' AND agent_name='Orchestrator';")
    if [ -n "$ORCH" ] && [ "$ORCH" != "RUNNING" ]; then
      break
    fi
    ELAPSED=$(( $(date +%s) - T0 ))
    if [ "$ELAPSED" -gt "$MAX_CYCLE_WAIT" ]; then
      ORCH="TIMEOUT"
      echo "[$i] cycle MAX_CYCLE_WAIT(${MAX_CYCLE_WAIT}s) 초과 — 강제 종료"
      break
    fi
    if [ $((ELAPSED % 60)) -lt 6 ] && [ "$ELAPSED" -gt 30 ]; then
      AGENTS=$(MYSQL -N -e "SELECT GROUP_CONCAT(CONCAT(agent_name,'=',status) SEPARATOR ',') FROM log_agent_runs WHERE task_id='$TASK' AND id > (SELECT MIN(id) FROM log_agent_runs WHERE task_id='$TASK');")
      echo "[$i] ... ${ELAPSED}s — $AGENTS"
    fi
    sleep 6
  done

  # [5] 집계
  END_AT=$(MYSQL -N -e "SELECT ended_at FROM log_agent_runs WHERE task_id='$TASK' AND agent_name='Orchestrator';")
  DURATION=$(MYSQL -N -e "SELECT TIMESTAMPDIFF(SECOND, started_at, IFNULL(ended_at, NOW())) FROM log_agent_runs WHERE task_id='$TASK' AND agent_name='Orchestrator';")
  VERDICT=$(MYSQL -N -e "SELECT final_verdict FROM log_agent_decisions WHERE task_id='$TASK' LIMIT 1;")
  [ -z "$VERDICT" ] && VERDICT="(no decision)"
  PHASES=$(MYSQL -N -e "SELECT GROUP_CONCAT(CONCAT(agent_name,':',status) SEPARATOR ' ') FROM log_agent_runs WHERE task_id='$TASK' ORDER BY id;")

  printf "%d\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$i" "$TASK" "$START_AT" "$END_AT" "$DURATION" "$VERDICT" "$PHASES" >> "$RESULTS"

  echo "[$i] DONE — verdict=$VERDICT, duration=${DURATION}s"
  echo ""

  if [ "$i" -lt "$N_CYCLES" ]; then
    echo "[$i] cooldown ${COOLDOWN_BETWEEN_CYCLES}s..."
    sleep "$COOLDOWN_BETWEEN_CYCLES"
  fi
done

echo "════════════════════════════════════════════════"
echo "  All $N_CYCLES cycles done."
echo "  Results: $RESULTS"
echo "════════════════════════════════════════════════"

echo ""
echo "=== 결과 요약 ==="
awk -F'\t' 'NR>1 {
  total++;
  if ($6=="PASS") pass++;
  else if ($6=="FAIL") fail++;
  else if ($6=="ERROR") err++;
  sum_dur += $5;
  if ($5>max_dur) max_dur=$5;
  if (min_dur==""||$5<min_dur) min_dur=$5;
}
END {
  printf "  total=%d  PASS=%d  FAIL=%d  ERROR=%d\n", total, pass+0, fail+0, err+0;
  if (total>0) printf "  duration  avg=%.1fs  min=%ss  max=%ss\n", sum_dur/total, min_dur, max_dur;
}' "$RESULTS"
