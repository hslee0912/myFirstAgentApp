#!/usr/bin/env bash
# Stop UI servers — 먼저 cycle Deploy 잔존 컨테이너 정리 후 UI 프로세스 종료.
#
# 순서가 중요한 이유: UI 서버를 *먼저* 죽이면 향후 `npm run ui`로 다시 띄울 때
# 떠 있는 cycle artifact가 health probe·container_cleanup 로직과 충돌 가능.
# 컨테이너부터 정리하고 마지막에 UI 서버 종료가 안전한 순서.
#
# 1단계 — Docker 컨테이너 정리:
#   `com.myfirstagentapp.managed=true` 라벨이 붙은 컨테이너 (cycle Deploy
#   Phase 8이 띄운 BE/FE) 를 모두 stop + rm. 라벨은
#   lib/stack_templates/docker-compose.yml 의 `labels:` 섹션에서 부여됨
#   (lib/container_cleanup.js 와 동일 정책).
#
# 2단계 — UI 서버 프로세스 종료:
#   `node .../ui/server.js` 매칭하는 모든 PID에 SIGTERM. 0.5초 후 잔존하면
#   SIGKILL fallback.
#
# 사용:
#   bash scripts/stop-ui.sh            # 정상 종료
#   FORCE=1 bash scripts/stop-ui.sh    # 처음부터 SIGKILL
#   SKIP_DOCKER=1 bash scripts/stop-ui.sh   # 컨테이너 정리 skip (UI만 종료)

set -u

MANAGED_LABEL="com.myfirstagentapp.managed=true"

###################################
# 1단계: Docker 컨테이너 정리
###################################
if [ "${SKIP_DOCKER:-0}" != "1" ]; then
  if command -v docker >/dev/null 2>&1; then
    # 라벨 기반으로 cycle artifact 컨테이너 ID 수집 (실행 중 + 정지 모두).
    MANAGED_IDS=$(docker ps -aq --filter "label=$MANAGED_LABEL" 2>/dev/null)

    if [ -z "$MANAGED_IDS" ]; then
      echo "ℹ️  관리 대상 컨테이너 없음 ($MANAGED_LABEL)."
    else
      echo "발견된 관리 대상 컨테이너:"
      docker ps -a --filter "label=$MANAGED_LABEL" \
        --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}' 2>/dev/null
      echo ""
      echo "→ docker stop …"
      # shellcheck disable=SC2086
      docker stop $MANAGED_IDS >/dev/null 2>&1 || true
      echo "→ docker rm …"
      # shellcheck disable=SC2086
      docker rm -f $MANAGED_IDS >/dev/null 2>&1 || true

      # 같이 만들어진 compose network 정리 (orphan 네트워크 제거).
      docker network prune -f >/dev/null 2>&1 || true
      echo "✅ 컨테이너 정리 완료."
    fi
  else
    echo "⚠️  docker 명령 없음 — 컨테이너 정리 skip."
  fi
else
  echo "ℹ️  SKIP_DOCKER=1 — 컨테이너 정리 skip."
fi

echo ""

###################################
# 2단계: UI 서버 프로세스 종료
###################################
PIDS=$(pgrep -af 'node .*ui/server\.js' 2>/dev/null | awk '{print $1}')

if [ -z "$PIDS" ]; then
  echo "ℹ️  떠 있는 UI 서버 없음 (node ui/server.js 프로세스 0개)."
  exit 0
fi

echo "발견된 UI 서버 PID:"
pgrep -af 'node .*ui/server\.js' 2>/dev/null || true

SIGNAL="TERM"
if [ "${FORCE:-0}" = "1" ]; then
  SIGNAL="KILL"
fi

echo ""
echo "→ SIG$SIGNAL 전송 …"
# shellcheck disable=SC2086
kill -s "$SIGNAL" $PIDS 2>/dev/null || true

# 잔존 확인 (TERM은 비동기 — 0.5초 후 확인).
sleep 0.5
LEFT=$(pgrep -af 'node .*ui/server\.js' 2>/dev/null | awk '{print $1}')

if [ -z "$LEFT" ]; then
  echo "✅ 모든 UI 서버 종료됨."
  exit 0
fi

echo "⚠️  아직 떠 있는 PID:"
pgrep -af 'node .*ui/server\.js' 2>/dev/null
echo ""
echo "→ SIGKILL 재시도 …"
# shellcheck disable=SC2086
kill -9 $LEFT 2>/dev/null || true
sleep 0.3

FINAL=$(pgrep -af 'node .*ui/server\.js' 2>/dev/null || true)
if [ -z "$FINAL" ]; then
  echo "✅ 강제 종료 완료."
else
  echo "❌ 종료 실패 (권한·좀비 등). 수동 확인:"
  echo "$FINAL"
  exit 1
fi
