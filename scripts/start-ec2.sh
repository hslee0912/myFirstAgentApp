#!/usr/bin/env bash
# EC2 부팅 / 새 SSH 세션 시 환경 초기화 + UI 서버 가동을 한 번에.
#
# 절차:
#   1. scripts/stop-ui.sh — 잔존 managed Docker 컨테이너 + UI 서버 모두 종료.
#      Docker 데몬이 떠 있지 않으면 컨테이너 정리는 silent skip (UI 종료만 동작).
#   2. Gerrit 데몬 정리 (OOM 방지) — gerrit.service 존재 시 stop + disable.
#      `procedure_new_server_setup.md §1.5` 참조 — Gerrit 480 MB 상시 + cycle과 무관,
#      OOM 원인 #1. idempotent — 이미 stopped/disabled / 미설치이면 skip.
#   3. Docker 데몬 가동 보장 — 이미 응답하면 noop, 아니면 `sudo systemctl start docker`.
#   4. Docker 데몬 응답 대기 — `docker info` 성공할 때까지 최대 30초.
#   5. UI 서버 detached 가동 — nohup으로 npm run ui 실행, 로그는 /tmp/ui_server.log.
#      "listening on" 로그 라인이 보일 때까지 대기 후 URL을 출력.
#
# 사용: bash scripts/start-ec2.sh
#
# 환경변수:
#   UI_LOG=/path/to/log    UI 서버 stdout/stderr 로그 경로 (default /tmp/ui_server.log)
#   STARTUP_TIMEOUT=20     UI startup "listening on" 대기 초 (default 20)

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_LOG="${UI_LOG:-/tmp/ui_server.log}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-20}"

###################################
# 1/5 잔존 컨테이너 + UI 정리
###################################
echo "━━━ 1/5 잔존 컨테이너 + UI 정리 ━━━"
bash "$ROOT/scripts/stop-ui.sh" || true

###################################
# 2/5 Gerrit 정리 (OOM 방지)
###################################
echo ""
echo "━━━ 2/5 Gerrit 데몬 정리 (OOM 방지) ━━━"
if systemctl list-unit-files gerrit.service >/dev/null 2>&1 && \
   systemctl cat gerrit.service >/dev/null 2>&1; then
  ACTIVE=$(systemctl is-active gerrit 2>/dev/null || true)
  ENABLED=$(systemctl is-enabled gerrit 2>/dev/null || true)
  if [ "$ACTIVE" = "active" ] || [ "$ENABLED" = "enabled" ]; then
    echo "→ sudo systemctl stop+disable gerrit"
    sudo -n systemctl stop gerrit 2>/dev/null || true
    sudo -n systemctl disable gerrit 2>/dev/null || true
    echo "  → is-active=$(systemctl is-active gerrit 2>&1) / is-enabled=$(systemctl is-enabled gerrit 2>&1)"
  else
    echo "✅ gerrit 이미 정지·비활성 상태 (is-active=$ACTIVE, is-enabled=$ENABLED)"
  fi
else
  echo "ℹ️  gerrit.service 미설치 — skip"
fi

###################################
# 3/5 Docker 데몬 가동 보장
###################################
echo ""
echo "━━━ 3/5 Docker Engine 가동 보장 ━━━"
if docker info >/dev/null 2>&1; then
  echo "✅ Docker 데몬 이미 응답 중 — 가동 skip"
else
  echo "→ Docker 데몬 응답 없음, sudo systemctl start docker 시도"
  if sudo -n systemctl start docker 2>/dev/null; then
    echo "  systemctl start docker OK"
  else
    echo "❌ sudo systemctl start docker 실패 (sudo 권한 또는 systemd 미사용 환경)."
    echo "   수동 가동 후 재실행: sudo systemctl start docker"
    exit 1
  fi
fi

###################################
# 4/5 Docker 데몬 응답 대기
###################################
echo ""
echo "━━━ 4/5 Docker 데몬 응답 대기 (최대 30초) ━━━"
DOCKER_READY=0
for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    echo "✅ docker info 응답 OK (${i}s)"
    DOCKER_READY=1
    break
  fi
  sleep 1
done
if [ "$DOCKER_READY" != "1" ]; then
  echo "❌ Docker 데몬 30초 동안 응답 없음."
  exit 1
fi

###################################
# 5/5 UI 서버 detached 가동
###################################
echo ""
echo "━━━ 5/5 UI 서버 가동 (detached, 로그=$UI_LOG) ━━━"
cd "$ROOT"

# 이전 로그 truncate (직전 세션 로그가 누적되지 않게).
: > "$UI_LOG"

# nohup으로 부모 셸이 끊겨도 살아남게. setsid 없어도 nohup이 SIGHUP 무시.
nohup npm run ui > "$UI_LOG" 2>&1 &
UI_WRAPPER_PID=$!
echo "→ npm run ui 시작 (wrapper PID=$UI_WRAPPER_PID)"
echo "  exec 체인: npm → launch-ui.sh → node ui/server.js"
echo "  실제 node ui/server.js PID는 launch-ui.sh가 exec 후 동일 PID 유지."

# "listening on" 라인 보일 때까지 polling
for i in $(seq 1 "$STARTUP_TIMEOUT"); do
  sleep 1
  if grep -q "listening on" "$UI_LOG" 2>/dev/null; then
    URL=$(grep "listening on" "$UI_LOG" | head -1 | sed 's/.*listening on //')
    echo "✅ UI 서버 가동 ($i초): $URL"
    echo ""
    echo "다음 단계: 브라우저로 위 URL 접속 (또는 nginx 경유)."
    exit 0
  fi
  # 빠른 fail-fast: 명백한 에러 패턴이 보이면 즉시 중단
  if grep -qE "EADDRINUSE|Cannot find module|throw |Error:" "$UI_LOG" 2>/dev/null; then
    echo "❌ UI 서버 시작 에러 감지 — 로그:"
    tail -30 "$UI_LOG"
    exit 1
  fi
done

echo "⚠️  ${STARTUP_TIMEOUT}초 안에 listening 로그 못 봄. 최근 로그:"
tail -30 "$UI_LOG"
exit 1
