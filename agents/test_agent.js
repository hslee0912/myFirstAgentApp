/**
 * Phase 9 — PostTest Agent (deterministic, no LLM).
 *
 * Orchestrator integration contract:
 *   - Called AFTER deploy_agent.run() returns SUCCESS (D25=B).
 *   - Skipped (auto-SUCCESS) when DEPLOY_MODE=off (D26=A pattern).
 *   - On overall PASS, orchestrator calls deploy_agent.teardown() (D6=B).
 *
 * Behavior matrix:
 *   - DEPLOY_MODE=off       → SUCCESS row + skipped note.
 *   - all endpoints PASS    → SUCCESS row + compact summary.
 *   - any endpoint FAIL     → FAILED row + per-endpoint details (debug-rich).
 *   - timeout / fetch error → FAILED row + error message.
 *
 * Decision provenance (docs/DECISIONS.md, 2026-05-08):
 *   D3, D4, D5, D8, D25, D26, D37 + auto pattern from deploy_agent.
 *
 * Schema requirement:
 *   `log_agent_runs.agent_name` ENUM must include 'PostTest' (S8 migration).
 *   Until S8 is done, this module will fail at logger.startRun() with an ENUM error.
 */
'use strict';

const logger = require('../lib/logger');
const apiTest = require('../lib/api_test');

// ---------------- env helpers ----------------

function getDeployMode() {
  return (process.env.DEPLOY_MODE || 'on').toLowerCase();
}

function getTimeoutMs() {
  return Number(process.env.POSTTEST_TIMEOUT_SEC || 60) * 1000;
}

function getBeBaseUrl() {
  const port = Number(process.env.DEPLOY_PORT_BE || 3001);
  // PostTest runs on the same host as the BE container (orchestrator +
  // docker compose are co-located). PUBLIC_HOST exists for the *browser's*
  // benefit (EC2 public DNS, etc.); for a server-side fetch on the same
  // box, 'localhost' is always correct. We still respect PUBLIC_HOST when
  // explicitly set to anything non-'localhost', for setups that route
  // through a public DNS even from inside the box.
  const envHost = (process.env.PUBLIC_HOST || '').trim();
  const host = envHost && envHost !== 'localhost' ? envHost : 'localhost';
  return `http://${host}:${port}`;
}

// ---------------- timeout helper ----------------

/**
 * Race `promise` against a timeout. Resolves with the promise's value or
 * rejects with a timeout Error after `timeoutMs`.
 *
 * Used because `apiTest.runContract` is fetch-based (async), so we can't use
 * `spawnSync`'s timeout option like deploy_agent does for docker-compose.
 */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer));
}

// ---------------- main run flow ----------------

/**
 * Phase 9 main entry. Inserts a log_agent_runs row and finalizes it.
 *
 * @param {{ task_id: string }} params
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED', skipped?: boolean }>}
 */
async function run({ task_id }) {
  const mode = getDeployMode();
  const timeoutMs = getTimeoutMs();
  const baseUrl = getBeBaseUrl();

  const run_id = await logger.startRun({
    task_id,
    agent_name: 'PostTest',
    input_json: { mode, baseUrl, timeoutMs },
  });

  // D26=A pattern: DEPLOY_MODE=off → auto-SUCCESS with skipped note
  if (mode !== 'on') {
    console.log('[posttest] DEPLOY_MODE=off — Phase 9 skipped (auto-SUCCESS)');
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: { skipped: 'DEPLOY_MODE=off' },
    });
    return { status: 'SUCCESS', skipped: true };
  }

  // Run contract test with timeout (D37=A)
  let result;
  try {
    result = await withTimeout(
      apiTest.runContract({ baseUrl }),
      timeoutMs,
      'PostTest'
    );
  } catch (e) {
    console.error(`[posttest] ${e.message}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { pass: false, error: e.message, baseUrl },
    });
    return { status: 'FAILED' };
  }

  // SUCCESS path: compact summary, no per-endpoint detail
  if (result.pass) {
    console.log(
      `[posttest] PASS: ${result.passed}/${result.total} endpoints (${result.duration_ms}ms)`
    );
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: {
        pass: true,
        total: result.total,
        passed: result.passed,
        duration_ms: result.duration_ms,
        baseUrl,
      },
    });
    return { status: 'SUCCESS' };
  }

  // FAIL path: include per-endpoint details (each result has trace + errors)
  console.error(
    `[posttest] FAIL: ${result.passed}/${result.total} endpoints passed`
  );
  await logger.endRun(run_id, {
    status: 'FAILED',
    output_json: {
      pass: false,
      total: result.total,
      passed: result.passed,
      duration_ms: result.duration_ms,
      baseUrl,
      results: result.results,
    },
  });
  return { status: 'FAILED' };
}

module.exports = { run };
