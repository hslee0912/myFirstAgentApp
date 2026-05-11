/**
 * Git rollback:
 *   GET  /api/rollback-preview — what would Reset to origin/main throw away?
 *   POST /api/rollback         — actually do it.
 *
 * .env handling — "structure-from-example, values-from-backup":
 *   1. UI 서버는 시작 시 자동으로 현재 .env를 .env.backup으로 스냅샷한다
 *      (ui/server.js#snapshotEnvOnStart). 즉 rollback 시점에서 .env.backup은
 *      *직전 UI 세션이 사용하던 .env 그대로*.
 *   2. rollback은 .env.example을 .env로 복사한다 (새로 추가된 키 / 갱신된
 *      주석 / 섹션 헤더 모두 .env.example을 source of truth로).
 *   3. 그 위에 .env.backup의 *non-empty 값*을 overlay (있는 키만, 빈
 *      문자열 값은 placeholder를 덮지 않도록 거른다).
 *
 * 효과: 코드는 origin/main으로 reset되지만 secret/토글은 손실 없이 복구.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { readEnv, updateEnv } = require('../../lib/env_writer');
const { ROOT, ENV_PATH, gitOut } = require('./_context');

const BACKUP_PATH = path.join(ROOT, '.env.backup');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

const router = express.Router();

router.get('/rollback-preview', (_req, res) => {
  // Best-effort fetch so origin/main is current. Failures are non-fatal —
  // we'll just preview against whatever local origin/main we have.
  gitOut(['fetch', 'origin', 'main']);
  const aheadOut = gitOut(['log', '--oneline', 'origin/main..HEAD']);
  const ahead = aheadOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const statusOut = gitOut(['status', '--porcelain']);
  const dirty = statusOut.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((line) => {
      // Only count paths we actually clean — BE/, FE/, shared/. Ignore
      // node_modules / .claude / *.log / .env (these are preserved or untouched).
      const m = line.match(/^..\s+(.+)$/);
      const p = m ? m[1] : line;
      if (/^node_modules\//.test(p) || /^\.claude\//.test(p) || /\.log$/.test(p)) return false;
      if (p === '.env' || /\.env\.backup/.test(p)) return false;
      return /^(BE|FE|shared)\//.test(p) || /^\.env\.tmp$/.test(p) || /^[^/]+$/.test(p);
    });
  const envExists = fs.existsSync(ENV_PATH);
  const exampleExists = fs.existsSync(EXAMPLE_PATH);
  const backupExists = fs.existsSync(BACKUP_PATH);

  // Surface how many backup values would land back on the restored .env.
  // Empty values don't count — they wouldn't overlay anything anyway.
  let restorableKeyCount = 0;
  if (backupExists) {
    try {
      const backup = readEnv(BACKUP_PATH);
      restorableKeyCount = Object.values(backup).filter((v) => v && v.trim()).length;
    } catch (_) { /* ignore — preview is best-effort */ }
  }

  res.json({
    ahead_commits: ahead,                // local commits that will disappear
    dirty_files: dirty,                  // working-dir paths that will be cleaned
    env_will_reset: envExists && exampleExists,
    backup_exists: backupExists,
    restorable_key_count: restorableKeyCount,
    backup_path: '.env.backup',
    can_rollback: ahead.length > 0 || dirty.length > 0,
  });
});

router.post('/rollback', (_req, res) => {
  try {
    // 1. git reset --hard origin/main — 코드 reset
    const reset = gitOut(['reset', '--hard', 'origin/main']);
    if (reset.code !== 0) {
      return res.status(500).json({ ok: false, error: `git reset failed: ${reset.stderr}` });
    }

    // 2. git clean -fd for BE/, FE/, shared/ — untracked LLM artifacts.
    //    .env / .env.backup / node_modules / .claude / *.log은 -e로 제외.
    const clean = gitOut([
      'clean', '-fd',
      '-e', '.env', '-e', '.env.backup', '-e', 'node_modules', '-e', '.claude/', '-e', '*.log',
      'BE/', 'FE/', 'shared/',
    ]);
    if (clean.code !== 0) {
      // Non-fatal — partial cleanup still useful. Report stderr but mark ok.
      console.warn(`[ui] rollback: git clean warning: ${clean.stderr}`);
    }

    // 3. .env 재구성: .env.example을 기반으로 .env.backup 값을 overlay.
    const result = restoreEnvFromExampleAndBackup();

    res.json({
      ok: true,
      reset_to: 'origin/main',
      env_reset: result.envReset,
      backup_path: '.env.backup',
      restored_keys: result.restoredKeys,
      backup_missing: result.backupMissing,
      notice: buildRollbackNotice(result),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Reset .env to .env.example structure + .env.backup values overlay.
 *
 * 1. .env.example이 없으면 — .env 그대로 두고 envReset=false 리턴.
 *    (rollback 자체는 의미 있지만 .env는 손 못 댐.)
 * 2. .env.example을 .env로 그대로 복사 — 주석/섹션 헤더/키 순서 보존.
 * 3. .env.backup이 있으면 그 안의 *non-empty* 값으로 .env를 overlay.
 *    빈 값은 무시 — placeholder를 덮으면 오히려 손실.
 *    .env.example에 없는 obsolete 키도 자동 폐기 (overlay는 기존 키만 갱신).
 *
 * @returns {{envReset: boolean, restoredKeys: string[], backupMissing: boolean}}
 */
function restoreEnvFromExampleAndBackup() {
  if (!fs.existsSync(EXAMPLE_PATH)) {
    return { envReset: false, restoredKeys: [], backupMissing: !fs.existsSync(BACKUP_PATH) };
  }

  // .env.example을 그대로 .env로 복사 (구조 reset)
  fs.copyFileSync(EXAMPLE_PATH, ENV_PATH);

  // .env.backup이 없으면 placeholder 그대로 — 사용자가 secret 다시 입력해야 함.
  if (!fs.existsSync(BACKUP_PATH)) {
    return { envReset: true, restoredKeys: [], backupMissing: true };
  }

  const backup = readEnv(BACKUP_PATH);
  const example = readEnv(EXAMPLE_PATH);

  // Overlay 대상 = .env.example에 존재하는 키 ∩ .env.backup에 non-empty 값.
  // 빈 값을 placeholder 위에 덮어쓰면 손실이라 거른다.
  const overlay = {};
  for (const k of Object.keys(backup)) {
    const v = backup[k];
    if (!v || !String(v).trim()) continue;
    if (!(k in example)) continue;       // example에 없는 obsolete 키는 폐기
    overlay[k] = String(v);
  }

  if (Object.keys(overlay).length > 0) {
    updateEnv(ENV_PATH, overlay);
  }

  return { envReset: true, restoredKeys: Object.keys(overlay).sort(), backupMissing: false };
}

// ---------------- Merge to main (push branch + ff origin/main) ----------------

/**
 * Preview what "🔀 Merge to main" 버튼이 origin에 보낼지 — 클릭 전 사용자가
 * 명확히 확인할 수 있도록.
 *
 * Returns:
 *   - branch:          현재 브랜치 이름
 *   - ahead_commits:   origin/main..HEAD (main에 합쳐질 commit들, oneline)
 *   - ff_possible:     origin/main이 HEAD의 조상 → ff push 가능?
 *   - dirty_files:     commit 안 한 작업 (있으면 merge 거부)
 *   - can_merge:       위 세 조건이 모두 우호적인지
 *   - reason:          can_merge=false일 때 사람이 읽을 안내
 */
router.get('/merge-preview', (req, res) => {
  // origin/main 최신 정보 확보. 실패는 non-fatal — 그 경우 *마지막으로 알려진*
  // origin/main 기준으로 preview를 보여줌.
  //
  // ?fetch=0 query는 polling용 경량 호출 (network round-trip 생략). UI 측의
  // pollMergeStatus는 1.5초마다 이걸 호출해 버튼 enable 여부를 결정하는데
  // 매번 fetch까지 하면 git server에 부담이라 옵트아웃 가능하게 둠. 사용자가
  // 실제 버튼을 누르는 시점엔 query 없이 호출해 fresh fetch.
  if (req.query.fetch !== '0') {
    gitOut(['fetch', 'origin', 'main']);
  }

  const branchOut = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (branchOut.stdout || '').trim() || 'HEAD';

  const aheadOut = gitOut(['log', '--oneline', 'origin/main..HEAD']);
  const ahead = aheadOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  // origin/main 이 HEAD의 조상이면 fast-forward 가능.
  const ancestry = gitOut(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  const ff_possible = ancestry.code === 0;

  // commit 안 한 변경 (.env / node_modules / .claude / log 제외 — 다른 곳과 동일).
  const statusOut = gitOut(['status', '--porcelain']);
  const dirty = statusOut.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((line) => {
      const m = line.match(/^..\s+(.+)$/);
      const p = m ? m[1] : line;
      if (/^node_modules\//.test(p) || /^\.claude\//.test(p) || /\.log$/.test(p)) return false;
      if (p === '.env' || /\.env\.backup/.test(p)) return false;
      return true;
    });

  const canMerge = ahead.length > 0 && ff_possible && dirty.length === 0;
  let reason = '';
  if (ahead.length === 0) reason = '이미 origin/main과 동일 — push할 commit이 없습니다.';
  else if (dirty.length > 0) reason = `commit 안 된 변경 ${dirty.length}개가 있습니다. 먼저 commit하거나 정리 후 다시 시도하세요.`;
  else if (!ff_possible) reason = 'origin/main이 현재 브랜치보다 앞서있어 fast-forward 불가. 먼저 origin/main을 rebase하거나 GitHub PR로 처리하세요.';

  res.json({ branch, ahead_commits: ahead, ff_possible, dirty_files: dirty, can_merge: canMerge, reason });
});

/**
 * 1) git push origin <branch>            — 현재 브랜치를 원격에 백업 push
 * 2) git push origin <branch>:main       — origin/main으로 fast-forward push
 *
 * force/lease는 절대 사용하지 않음. ff 실패는 그대로 사용자에게 전파.
 * dirty/ff-impossible/no-ahead은 호출 전에 거부 — preview API와 동일 조건.
 */
router.post('/merge', (_req, res) => {
  try {
    // 사전 검증 — preview와 같은 조건. 사용자가 preview 안 보고 직접 호출한
    // 경우에도 보호.
    gitOut(['fetch', 'origin', 'main']);

    const branchOut = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = (branchOut.stdout || '').trim();
    if (!branch || branch === 'HEAD') {
      return res.status(400).json({ ok: false, error: 'detached HEAD 상태로는 merge할 수 없습니다. 브랜치를 명시적으로 checkout하세요.' });
    }
    if (branch === 'main') {
      return res.status(400).json({ ok: false, error: '현재 브랜치가 이미 main입니다. UI는 feature branch에서만 사용하세요.' });
    }

    const aheadOut = gitOut(['log', '--oneline', 'origin/main..HEAD']);
    const ahead = aheadOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ahead.length === 0) {
      return res.json({ ok: true, no_op: true, pushed_branch: false, merged_to_main: false, notice: '이미 origin/main과 동일 — 아무것도 안 함.' });
    }

    const ancestry = gitOut(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
    if (ancestry.code !== 0) {
      return res.status(409).json({ ok: false, error: 'origin/main이 현재 브랜치보다 앞서있어 fast-forward 불가. rebase 또는 PR로 처리하세요.' });
    }

    const statusOut = gitOut(['status', '--porcelain']);
    const dirty = statusOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((line) => {
        const m = line.match(/^..\s+(.+)$/);
        const p = m ? m[1] : line;
        if (/^node_modules\//.test(p) || /^\.claude\//.test(p) || /\.log$/.test(p)) return false;
        if (p === '.env' || /\.env\.backup/.test(p)) return false;
        return true;
      });
    if (dirty.length > 0) {
      return res.status(409).json({ ok: false, error: `commit 안 된 변경 ${dirty.length}개가 있습니다. 먼저 commit하세요.`, dirty_files: dirty });
    }

    // 1) push current branch — 히스토리 백업
    const pushBranch = gitOut(['push', 'origin', branch]);
    if (pushBranch.code !== 0) {
      return res.status(500).json({ ok: false, error: `git push origin ${branch} 실패: ${pushBranch.stderr.trim()}` });
    }

    // 2) ff push to main — 실제 "merge"
    const pushMain = gitOut(['push', 'origin', `${branch}:main`]);
    if (pushMain.code !== 0) {
      return res.status(500).json({
        ok: false,
        error: `git push origin ${branch}:main 실패: ${pushMain.stderr.trim()}`,
        pushed_branch: true,
        merged_to_main: false,
      });
    }

    res.json({
      ok: true,
      branch,
      pushed_commits: ahead,
      pushed_branch: true,
      merged_to_main: true,
      notice: `${ahead.length}개 commit이 origin/${branch} 와 origin/main 양쪽에 fast-forward됨.`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function buildRollbackNotice({ envReset, restoredKeys, backupMissing }) {
  if (!envReset) return '.env.example을 찾지 못해 .env는 그대로 유지.';
  if (backupMissing) {
    return '.env가 .env.example로 reset됨. .env.backup이 없어 secret을 다시 입력해야 합니다.';
  }
  if (restoredKeys.length === 0) {
    return '.env가 .env.example로 reset됨. .env.backup에 복구 가능한 값이 없어 placeholder 그대로.';
  }
  const sample = restoredKeys.slice(0, 5).join(', ');
  const more = restoredKeys.length > 5 ? ` 외 ${restoredKeys.length - 5}개` : '';
  return `.env가 .env.example 구조로 reset되고 .env.backup의 ${restoredKeys.length}개 값(${sample}${more})으로 복원됨.`;
}

module.exports = router;
