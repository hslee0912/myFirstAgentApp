#!/usr/bin/env bash
# Launch UI control panel — 항상 .claude/worktrees/test 워크트리에서 실행됨을 보장.
#
# Why: 메인 워크트리에서 UI를 띄우면 Run Pipeline이 cycle을 메인 디렉터리에서
# 트리거 → BE/FE 산출물이 메인에 생성되어 워크플로우 정책 위반 (cycle은 항상
# test 워크트리에서만 — feedback_workflow.md / rules/ 참조).
#
# 호출: `npm run ui` (어디서든). npm이 이 스크립트를 호출하며 cwd = 호출한
# 위치의 package.json 디렉터리. cwd가 메인이면 자동으로 test 워크트리로
# redirect 후 node ui/server.js 실행. 이미 test 워크트리 안이면 그대로.
#
# 디버깅/테스트용 환경변수:
#   UI_DRY_RUN=1 — 실제 node ui/server.js exec 대신 결정된 cwd + 명령만 출력
#                  후 exit 0. 단위 테스트가 이 모드로 wrapper 동작만 검증.
#
# 폐기된 명령: `npm run ui:test` — scripts/deprecated-ui-test.sh로 에러 출력.
set -e

# 스크립트 위치 기반 — 호출자의 package.json 디렉터리 (PKG_ROOT).
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 로그 prefix — npm run output에서 다른 ui 로그와 일관성.
log() { echo "[ui:wrapper] $*"; }

log "PKG_ROOT=$PKG_ROOT"

case "$PKG_ROOT" in
  */.claude/worktrees/test)
    # 이미 test 워크트리 안 — redirect 불필요.
    log "cwd가 test 워크트리 — 직접 실행"
    TARGET_DIR="$PKG_ROOT"
    ;;
  *)
    # 메인(또는 다른) 워크트리 → test 워크트리로 redirect.
    TARGET_DIR="$PKG_ROOT/.claude/worktrees/test"
    if [ ! -d "$TARGET_DIR" ]; then
      log "❌ test 워크트리 없음: $TARGET_DIR" >&2
      log "   생성: git worktree add .claude/worktrees/test claude/test" >&2
      exit 1
    fi
    log "cwd=메인 → test 워크트리로 redirect: $TARGET_DIR"
    ;;
esac

cd "$TARGET_DIR"
log "now in: $(pwd)"
log "command: node ui/server.js"

if [ "${UI_DRY_RUN:-}" = "1" ]; then
  log "UI_DRY_RUN=1 — exec 생략 후 exit 0 (테스트 모드)"
  exit 0
fi

exec node ui/server.js
