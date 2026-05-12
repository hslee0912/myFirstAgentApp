/**
 * 머지된 PR의 잔재 워크트리·branch 일괄 정리.
 *
 *   GET  /api/cleanup-preview — 정리될 후보 + 정리 안 되는 사유까지 미리보기
 *   POST /api/cleanup-merged  — 실제 실행 (git worktree remove + git branch -d)
 *
 * 동작 (보수적·안전 우선):
 *   1. `git fetch --prune origin` — origin 최신 상태로 sync (best-effort).
 *   2. `git worktree list --porcelain` 으로 모든 워크트리 열거.
 *   3. 각 워크트리에 대해 classifyWorktree로 분류:
 *      - 메인 워크트리 (ROOT 자체) → skip
 *      - `main` / `claude/test` 같은 보호 branch → skip
 *      - detached HEAD / locked / uncommitted 변경 → skip
 *      - branch가 origin에서 사라졌거나 origin/main에 머지됨 → eligible
 *   4. eligible 워크트리만 `git worktree remove`(force X) + `git branch -d`(safe).
 *
 * 안전장치:
 *   - --force 안 씀: 워크트리에 untracked/uncommitted 있거나 IDE가 폴더 lock
 *     잡고 있으면 *조용히 skip*하고 failed[]에 사유 보고. 강제 삭제 X.
 *   - `git branch -d` 는 머지 안 된 branch를 거부 (safe). main 외에 머지된
 *     걸 명시적으로 확인하지만 git이 추가로 한 번 더 막아준다.
 *   - currentRunRef로 다른 orchestrator run 진행 중이면 409 거부.
 */
'use strict';

const express = require('express');
const { ROOT, currentRunRef, gitOut } = require('./_context');

const router = express.Router();

// 절대 정리 안 할 branch. main + 사용자가 재사용하는 단일 test 워크트리.
const PROTECTED_BRANCHES = new Set([
  'refs/heads/main',
  'refs/heads/claude/test',
]);

/**
 * `git worktree list --porcelain` 출력을 파싱.
 * 한 워크트리당 `worktree <path>` / `HEAD <sha>` / `branch <ref>` / `detached` /
 * `locked [reason]` 라인이 빈 줄로 구분되어 나옴.
 *
 * @returns {Array<{path:string, head:string, branch:string, detached:boolean, locked:boolean}>}
 */
function listWorktrees() {
  const out = gitOut(['worktree', 'list', '--porcelain']);
  if (out.code !== 0) return [];
  const entries = [];
  let cur = null;
  for (const raw of out.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { path: '', head: '', branch: '', detached: false, locked: false };
    if (line.startsWith('worktree '))    cur.path = line.slice('worktree '.length);
    else if (line.startsWith('HEAD '))   cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length);
    else if (line === 'detached')        cur.detached = true;
    else if (line.startsWith('locked'))  cur.locked = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

/** origin에 해당 branch가 더 이상 없는지 (= PR 머지 후 GitHub이 remote 정리한 상태). */
function isUpstreamGone(branchRef) {
  if (!branchRef || !branchRef.startsWith('refs/heads/')) return false;
  const localName = branchRef.slice('refs/heads/'.length);
  const r = gitOut(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${localName}`]);
  return r.code !== 0;
}

/** HEAD가 origin/main에 이미 포함됐는지 (= 머지됨). */
function isMergedIntoMain(headSha) {
  if (!headSha) return false;
  const r = gitOut(['merge-base', '--is-ancestor', headSha, 'origin/main']);
  return r.code === 0;
}

/** 워크트리 내부에 uncommitted 변경 있는지. `-C <path>`로 cwd override. */
function hasUncommitted(worktreePath) {
  const r = gitOut(['-C', worktreePath, 'status', '--porcelain']);
  return r.code === 0 && r.stdout.trim() !== '';
}

/**
 * 단일 워크트리를 분류해 eligible 여부 + 사유 반환.
 * 사유는 UI 보고용으로 한국어로 명시.
 */
function classifyWorktree(wt) {
  if (wt.path === ROOT)                  return { eligible: false, reason: '메인 워크트리 (보호)' };
  if (wt.locked)                         return { eligible: false, reason: 'worktree locked' };
  if (wt.detached)                       return { eligible: false, reason: 'detached HEAD (보호)' };
  if (!wt.branch)                        return { eligible: false, reason: 'branch 식별 불가' };
  if (PROTECTED_BRANCHES.has(wt.branch)) return { eligible: false, reason: '보호 대상 branch' };
  if (hasUncommitted(wt.path))           return { eligible: false, reason: 'uncommitted 변경 있음 — 수동 확인 필요' };

  const gone = isUpstreamGone(wt.branch);
  const merged = isMergedIntoMain(wt.head);
  if (gone && merged) return { eligible: true, reason: 'origin에서 삭제 + main 머지됨' };
  if (gone)           return { eligible: true, reason: 'origin에서 삭제됨' };
  if (merged)         return { eligible: true, reason: 'main에 머지됨' };
  return { eligible: false, reason: '아직 미머지 + origin 살아있음' };
}

router.get('/cleanup-preview', (_req, res) => {
  // origin 최신 sync (실패해도 진행 — preview는 best-effort).
  gitOut(['fetch', '--prune', 'origin']);

  const all = listWorktrees();
  const eligible = [];
  const skipped = [];
  for (const wt of all) {
    const c = classifyWorktree(wt);
    const item = {
      path: wt.path,
      branch: (wt.branch || '').replace(/^refs\/heads\//, '') || '(detached)',
      head: wt.head ? wt.head.slice(0, 7) : '',
      reason: c.reason,
    };
    (c.eligible ? eligible : skipped).push(item);
  }
  res.json({ eligible, skipped });
});

router.post('/cleanup-merged', (_req, res) => {
  // 다른 작업 진행 중이면 거부 (orchestrator run 같은 게 워크트리 건드릴 수 있음).
  if (currentRunRef.value) {
    return res.status(409).json({
      ok: false,
      error: '다른 작업 진행 중. 끝난 후 다시 시도하세요.',
      current: { task_id: currentRunRef.value.task_id, pid: currentRunRef.value.pid },
    });
  }

  gitOut(['fetch', '--prune', 'origin']);

  const all = listWorktrees();
  const removed = [];
  const failed = [];
  const skipped = [];

  for (const wt of all) {
    const branchName = (wt.branch || '').replace(/^refs\/heads\//, '');
    const c = classifyWorktree(wt);
    if (!c.eligible) {
      skipped.push({ path: wt.path, branch: branchName || '(detached)', reason: c.reason });
      continue;
    }

    // 1) worktree remove (no --force). VS Code/Conductor가 폴더 lock 잡고
    //    있으면 git이 거부 → failed[]에 사유 보고. 강제 삭제 안 함.
    const wtR = gitOut(['worktree', 'remove', wt.path]);
    if (wtR.code !== 0) {
      failed.push({
        path: wt.path,
        branch: branchName,
        step: 'worktree_remove',
        error: (wtR.stderr || wtR.stdout || 'unknown').trim(),
      });
      continue;
    }

    // 2) branch -d (safe). git이 한 번 더 머지 여부 확인. 머지 안 됐으면 거부.
    //    worktree는 이미 삭제됐으니 partial success로 보고.
    const brR = gitOut(['branch', '-d', branchName]);
    if (brR.code !== 0) {
      removed.push({ path: wt.path, branch: branchName, partial: true });
      failed.push({
        path: wt.path,
        branch: branchName,
        step: 'branch_delete',
        error: (brR.stderr || brR.stdout || 'unknown').trim(),
      });
      continue;
    }

    removed.push({ path: wt.path, branch: branchName, partial: false });
  }

  res.json({
    ok: true,
    removed,
    skipped,
    failed,
    summary: `정리 ${removed.length} · skip ${skipped.length} · 실패 ${failed.length}`,
  });
});

module.exports = router;
