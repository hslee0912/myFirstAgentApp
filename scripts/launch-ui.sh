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
# 폐기된 명령: `npm run ui:test` — scripts/deprecated-ui-test.sh로 에러 출력.
set -e

# 스크립트 위치 기반 — 호출자의 package.json 디렉터리 (PKG_ROOT).
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$PKG_ROOT" in
  */.claude/worktrees/test)
    # 이미 test 워크트리 안 — 그대로 실행.
    exec node ui/server.js
    ;;
  *)
    # 메인(또는 다른) 워크트리 → test 워크트리로 redirect.
    TEST_DIR="$PKG_ROOT/.claude/worktrees/test"
    if [ ! -d "$TEST_DIR" ]; then
      echo "[ui] ❌ test 워크트리 없음: $TEST_DIR" >&2
      echo "[ui]    생성: git worktree add .claude/worktrees/test claude/test" >&2
      exit 1
    fi
    echo "[ui] cwd=$PKG_ROOT → test 워크트리로 redirect: $TEST_DIR"
    cd "$TEST_DIR"
    exec node ui/server.js
    ;;
esac
