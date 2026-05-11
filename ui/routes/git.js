/**
 * Git rollback:
 *   GET  /api/rollback-preview — what would Reset to origin/main throw away?
 *   POST /api/rollback         — actually do it (+ .env backup + reset from .env.example).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { ROOT, ENV_PATH, gitOut } = require('./_context');

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
  const envExampleExists = fs.existsSync(path.join(ROOT, '.env.example'));
  res.json({
    ahead_commits: ahead,                // local commits that will disappear
    dirty_files: dirty,                  // working-dir paths that will be cleaned
    env_will_reset: envExists && envExampleExists,
    backup_path: '.env.backup',          // existing backup will be overwritten
    can_rollback: ahead.length > 0 || dirty.length > 0,
  });
});

router.post('/rollback', (_req, res) => {
  try {
    // 1. .env backup (fixed name — overwrites any previous backup)
    let envBackedUp = false;
    if (fs.existsSync(ENV_PATH)) {
      fs.copyFileSync(ENV_PATH, path.join(ROOT, '.env.backup'));
      envBackedUp = true;
    }

    // 2. git reset --hard origin/main
    const reset = gitOut(['reset', '--hard', 'origin/main']);
    if (reset.code !== 0) {
      return res.status(500).json({ ok: false, error: `git reset failed: ${reset.stderr}` });
    }

    // 3. git clean -fd for BE/, FE/, shared/ — untracked LLM artifacts.
    //    .env / node_modules / .claude / *.log are excluded by -e patterns.
    const clean = gitOut([
      'clean', '-fd',
      '-e', '.env', '-e', '.env.backup', '-e', 'node_modules', '-e', '.claude/', '-e', '*.log',
      'BE/', 'FE/', 'shared/',
    ]);
    if (clean.code !== 0) {
      // Non-fatal — partial cleanup still useful. Report stderr but mark ok.
      console.warn(`[ui] rollback: git clean warning: ${clean.stderr}`);
    }

    // 4. .env reset from .env.example (placeholder values — user must re-enter secrets).
    let envReset = false;
    const examplePath = path.join(ROOT, '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, ENV_PATH);
      envReset = true;
    }

    res.json({
      ok: true,
      reset_to: 'origin/main',
      env_backed_up: envBackedUp,
      env_reset: envReset,
      backup_path: '.env.backup',
      notice: envReset
        ? 'ANTHROPIC_API_KEY와 DB_PASSWORD를 다시 입력해야 합니다 (.env.example의 placeholder로 reset됨). 이전 .env는 .env.backup에 백업.'
        : '.env.example을 찾지 못해 .env는 그대로 유지.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
