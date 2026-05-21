#!/usr/bin/env bash
# Stop all UI server processes — `node .../ui/server.js` 매칭하는 모든 PID 종료.
#
# Why: 여러 워크트리(메인 / test / verify-* 등)에서 launch-ui.sh를 여러 번 띄우면
# 같은 포트 충돌 또는 다른 워크트리에서 떠 있는 ui/server.js가 stale 상태로
# Cycle을 트리거할 수 있음. 종료 시 일괄 정리하기 위한 단일 스크립트.
#
# 사용:
#   bash scripts/stop-ui.sh           # 모든 ui/server.js PID 정상 종료 (SIGTERM)
#   FORCE=1 bash scripts/stop-ui.sh   # SIGKILL 강제 종료 (SIGTERM 안 받는 경우 fallback)
#
# 종료 후 PID·작업 디렉터리·UI_PORT 결과를 stdout에 요약.

set -u

# pgrep -af로 'node .../ui/server.js' 매칭. -a는 명령 라인 전체 표시 (어떤 워크트리
# 인지 식별), -f는 명령 라인 전체에 대한 매칭.
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
