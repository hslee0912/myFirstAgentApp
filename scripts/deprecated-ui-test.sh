#!/usr/bin/env bash
# Stub for the deprecated `npm run ui:test` command.
#
# History: 메인 워크트리에서 UI를 띄울 때 자동으로 test 워크트리로 redirect
# 하기 위해 별도 alias로 존재했음. 2026-05-19에 `npm run ui` 자체가
# scripts/launch-ui.sh로 wrap되어 cwd 기반 자동 redirect를 하게 되며 폐기.
#
# 출력은 stderr + non-zero exit으로 사용자가 명확히 인지하도록.
echo "[ui:test] ❌ DEPRECATED — 이 명령은 폐기되었습니다." >&2
echo "[ui:test]    'npm run ui'를 사용하세요." >&2
echo "[ui:test]    어디서 호출하든 (메인 또는 .claude/worktrees/test) 항상 test 워크트리에서 실행됩니다." >&2
exit 1
