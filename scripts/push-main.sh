#!/usr/bin/env bash
# Push to origin/main + 메인 워크트리 local main 동기화 + test 워크트리 정리.
#
# 배경:
# `git push origin claude/test:main`은 *remote main*만 갱신한다.
# 메인 워크트리(`/home/ubuntu/myFirstAgentApp`)의 *local main* branch는 그대로
# 뒤처져, 사용자가 메인에서 파일을 보면 *이전 commit 상태*로 보임 (혼란 사고
# 2026-05-27). 본 스크립트가 push + 두 워크트리 동기화를 한 번에 처리.
#
# 절차:
#   1. test 워크트리에서 `git push origin claude/test:main` (ff push)
#   2. 메인 워크트리에서 `git fetch origin && git reset --hard origin/main`
#      → local main이 origin/main과 정확히 일치
#   3. test 워크트리도 `git reset --hard origin/main + git clean -fd ...`
#      → cycle 산출물(BE/src, FE/src, shared/router) 정리. idempotent.
#
# 사용:
#   bash scripts/push-main.sh
#
# 가정:
#   - test 워크트리(`/home/ubuntu/myFirstAgentApp/.claude/worktrees/test`)에서 호출
#   - 직전에 사용자가 commit 완료 (이 스크립트는 commit 안 함, push만)
#
# 환경변수:
#   DRY_RUN=1     실제 push 안 함, 명령만 출력

set -u

TEST_WT="/home/ubuntu/myFirstAgentApp/.claude/worktrees/test"
MAIN_WT="/home/ubuntu/myFirstAgentApp"

run() {
  echo "→ $*"
  if [ "${DRY_RUN:-0}" != "1" ]; then
    eval "$@"
  fi
}

# 사전 점검 — test 워크트리에 unpushed commit 있어야 의미 있음
echo "━━━ 사전 상태 ━━━"
echo -n "test branch:    "; git -C "$TEST_WT" branch --show-current
echo -n "test HEAD:      "; git -C "$TEST_WT" log -1 --oneline
echo -n "origin/main:    "; git -C "$TEST_WT" log -1 origin/main --oneline 2>/dev/null || echo "(fetch 필요)"
echo ""

###################################
# 1단계: test 워크트리 → origin/main push
###################################
echo "━━━ 1/3 test 워크트리 → origin/main ff push ━━━"
run "git -C \"$TEST_WT\" push origin claude/test:main"
if [ $? -ne 0 ]; then
  echo "❌ push 실패. 중단."
  exit 1
fi
echo ""

###################################
# 2단계: 메인 워크트리 local main 동기화
###################################
echo "━━━ 2/3 메인 워크트리 local main 동기화 ━━━"
run "git -C \"$MAIN_WT\" fetch origin"
run "git -C \"$MAIN_WT\" reset --hard origin/main"
echo ""

###################################
# 3단계: test 워크트리 cycle 산출물 정리 (idempotent)
###################################
echo "━━━ 3/3 test 워크트리 reset + cycle 산출물 cleanup ━━━"
run "git -C \"$TEST_WT\" reset --hard origin/main"
# 산출물 디렉터리는 origin/main에 없을 수도 — clean -fd로 untracked 제거
run "git -C \"$TEST_WT\" clean -fd BE/src FE/src shared/router 2>&1 | tail -3"
echo ""

###################################
# 최종 검증
###################################
echo "━━━ 최종 상태 ━━━"
TEST_HEAD=$(git -C "$TEST_WT" rev-parse HEAD)
MAIN_HEAD=$(git -C "$MAIN_WT" rev-parse HEAD)
REMOTE_HEAD=$(git -C "$TEST_WT" rev-parse origin/main)
echo "test worktree:  $(git -C "$TEST_WT" log -1 --oneline)"
echo "main worktree:  $(git -C "$MAIN_WT" log -1 --oneline)"
echo "origin/main:    $REMOTE_HEAD"
echo ""
if [ "$TEST_HEAD" = "$MAIN_HEAD" ] && [ "$MAIN_HEAD" = "$REMOTE_HEAD" ]; then
  echo "✅ 세 곳 모두 동기화 완료 ($TEST_HEAD)"
  exit 0
else
  echo "⚠️  미동기화 — 수동 확인 필요"
  exit 1
fi
