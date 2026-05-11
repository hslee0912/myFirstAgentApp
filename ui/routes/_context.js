/**
 * Shared context for ui/routes/*.js modules.
 *
 * The UI server is split into per-domain route files (env / tasks / run /
 * deploy / git). They share three things:
 *   - constants (ROOT, ENV_PATH)
 *   - the single-orchestrator-run slot (mutable, read by run.js + deploy.js)
 *   - thin helpers (gitOut) and re-exported singletons (deployAgent, db)
 *
 * Importing this from a route file replaces what was previously direct access
 * to module-level vars inside the monolithic ui/server.js.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');

// Mutable single-run slot. `value` is null when idle, or
// { task_id, pid, startedAt, finishedAt?, exitCode?, log() } when an
// orchestrator child is alive (plus a ~10s tail after exit so UI polling
// can pick up the final state).
//
// run.js sets it; deploy.js reads it (Redeploy refuses while busy).
const currentRunRef = { value: null };

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

module.exports = {
  ROOT,
  ENV_PATH,
  currentRunRef,
  gitOut,
};
