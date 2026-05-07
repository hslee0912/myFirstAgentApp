/**
 * Pre-push gate: block `git push origin main` unless the latest Orchestrator
 * task ended with final_verdict='PASS'.
 *
 * Wired to .git/hooks/pre-push. Runs only when the push targets refs/heads/main.
 *
 * Exit codes:
 *   0 — push allowed (PASS, or no orchestrator runs yet, or non-main branch)
 *   1 — push blocked (FAIL / ERROR / IN_PROGRESS / DB error)
 *
 * Bypass: `git push --no-verify origin main`
 */
'use strict';

const db = require('./db');

(async () => {
  let exitCode = 1;
  try {
    const rows = await db.query(
      'SELECT task_id, final_verdict, final_result_text, updated_at ' +
      'FROM log_agent_decisions ORDER BY id DESC LIMIT 1'
    );

    if (rows.length === 0) {
      // First push — no orchestrator runs yet (e.g. README/docs initial commit).
      console.error('[pre-push] No orchestrator runs found in log_agent_decisions.');
      console.error('[pre-push] First-time push allowed.');
      exitCode = 0;
    } else {
      const { task_id, final_verdict, final_result_text, updated_at } = rows[0];

      if (final_verdict === 'PASS') {
        console.error(
          `[pre-push] ✅ PASS — task_id=${task_id} (verdict updated at ${formatTs(updated_at)})`
        );
        exitCode = 0;
      } else {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error(`[pre-push] ❌ Push to main BLOCKED`);
        console.error(`           latest task_id  : ${task_id}`);
        console.error(`           final_verdict   : ${final_verdict}`);
        console.error(`           updated_at      : ${formatTs(updated_at)}`);
        if (final_result_text) {
          console.error(`           reason          : ${truncate(final_result_text, 240)}`);
        }
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('[pre-push] Options:');
        console.error('[pre-push]   1) Run orchestrator until PASS:  npm start');
        console.error('[pre-push]   2) Bypass for non-code changes:  git push --no-verify');
        exitCode = 1;
      }
    }
  } catch (e) {
    // Fail-closed: any DB connection / query problem blocks the push.
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('[pre-push] ❌ DB check failed (fail-closed)');
    console.error(`           error: ${e.message}`);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('[pre-push] If MySQL is unreachable, either fix the connection,');
    console.error('[pre-push] or bypass this check with:  git push --no-verify');
    exitCode = 1;
  } finally {
    try { await db.close(); } catch (_) { /* ignore */ }
  }

  process.exit(exitCode);
})();

function formatTs(v) {
  if (!v) return '(unknown)';
  try {
    return new Date(v).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch (_) {
    return String(v);
  }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}
