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
