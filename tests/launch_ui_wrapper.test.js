'use strict';

/**
 * scripts/launch-ui.sh + scripts/deprecated-ui-test.sh 동작 검증.
 *
 * 두 wrapper script가 cwd 기반으로 올바른 분기를 하는지 확인.
 * UI_DRY_RUN=1로 실제 node ui/server.js exec 없이 결정 로직만 검증.
 *
 * 시나리오:
 *   1. PKG_ROOT = test 워크트리 → "직접 실행" 메시지 + redirect 안 함
 *   2. PKG_ROOT = 메인 워크트리 (test 폴더 있음) → "redirect" 메시지 + cd to test
 *   3. PKG_ROOT = 임의 경로 (test 폴더 없음) → fail-fast exit 1
 *   4. deprecated-ui-test.sh → exit 1 + stderr에 "DEPRECATED" 포함
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const LAUNCH_SCRIPT = path.join(ROOT, 'scripts', 'launch-ui.sh');
const DEPRECATED_SCRIPT = path.join(ROOT, 'scripts', 'deprecated-ui-test.sh');

// Helper: 임시 dir에 wrapper script만 symlink해 PKG_ROOT를 시뮬레이트.
// launch-ui.sh는 $(dirname $0)/.. 기준 PKG_ROOT 계산하므로,
// <tmp>/scripts/launch-ui.sh 형태로 두면 PKG_ROOT = <tmp>가 된다.
function setupFakePkgRoot(pkgRoot) {
  fs.mkdirSync(path.join(pkgRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(LAUNCH_SCRIPT, path.join(pkgRoot, 'scripts', 'launch-ui.sh'));
  fs.chmodSync(path.join(pkgRoot, 'scripts', 'launch-ui.sh'), 0o755);
}

test('launch-ui.sh: PKG_ROOT가 test 워크트리면 redirect 없이 직접 실행 분기', () => {
  // 가상 test 워크트리: <tmp>/.claude/worktrees/test
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ui-test-'));
  const testWorktree = path.join(tmp, '.claude', 'worktrees', 'test');
  setupFakePkgRoot(testWorktree);

  const r = spawnSync('bash', [path.join(testWorktree, 'scripts', 'launch-ui.sh')], {
    env: { ...process.env, UI_DRY_RUN: '1' },
    encoding: 'utf8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.equal(r.status, 0, `exit code (stderr: ${r.stderr})`);
  assert.match(r.stdout, /cwd가 test 워크트리 — 직접 실행/);
  assert.doesNotMatch(r.stdout, /redirect:/);
  assert.match(r.stdout, /UI_DRY_RUN=1/);
});

test('launch-ui.sh: PKG_ROOT가 메인이고 test 워크트리 존재하면 redirect', () => {
  // 가상 메인: <tmp> (scripts/launch-ui.sh + .claude/worktrees/test/ 존재)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ui-test-'));
  setupFakePkgRoot(tmp);
  fs.mkdirSync(path.join(tmp, '.claude', 'worktrees', 'test'), { recursive: true });

  const r = spawnSync('bash', [path.join(tmp, 'scripts', 'launch-ui.sh')], {
    env: { ...process.env, UI_DRY_RUN: '1' },
    encoding: 'utf8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.equal(r.status, 0, `exit code (stderr: ${r.stderr})`);
  assert.match(r.stdout, /cwd=메인 → test 워크트리로 redirect/);
  assert.match(r.stdout, /UI_DRY_RUN=1/);
});

test('launch-ui.sh: PKG_ROOT가 메인이지만 test 워크트리 없으면 exit 1 + 안내', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ui-test-'));
  setupFakePkgRoot(tmp);
  // .claude/worktrees/test 일부러 안 만듦

  const r = spawnSync('bash', [path.join(tmp, 'scripts', 'launch-ui.sh')], {
    env: { ...process.env, UI_DRY_RUN: '1' },
    encoding: 'utf8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.notEqual(r.status, 0, '실패 exit 기대');
  assert.match(r.stderr, /test 워크트리 없음/);
  assert.match(r.stderr, /git worktree add/);
});

test('deprecated-ui-test.sh: 항상 exit 1 + stderr DEPRECATED 메시지', () => {
  const r = spawnSync('bash', [DEPRECATED_SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DEPRECATED/);
  assert.match(r.stderr, /npm run ui/);
});
