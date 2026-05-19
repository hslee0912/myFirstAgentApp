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
  // PostTest는 orchestrator process (host)에서 직접 fetch — BE 컨테이너의
  // ports는 docker-compose.yml에서 127.0.0.1:port:port (localhost-only)로
  // bind. PUBLIC_HOST는 *브라우저*용 외부 도메인이며, 서버 내부에서 그 도메인으로
  // 가면 외부 NIC를 거쳐 SG(:3001 차단)에 막혀 timeout.
  // → 항상 localhost로 직접 접근 (Nginx 도입 후 BE 외부 직접 노출 X).
  return `http://localhost:${port}`;
}

// ---------------- BE warmup ----------------

/**
 * Phase 8(`docker compose up --wait`)은 컨테이너 *started* 시점까지만 기다림.
 * BE의 mysql2 connection pool은 **lazy init** — 첫 query 시 connect 시도.
 * BE listen 직후 PostTest가 즉시 fetch하면 DB 연결 setup이 안 끝나 await
 * 안에서 hang → PostTest 60s timeout. healthcheck로 BE가 *traffic ready*임을
 * 확인 후 본 시나리오 실행.
 *
 * 30s 안에 /health가 200 OK 떨어지면 통과. 못 떨어지면 PostTest에서 명확히
 * "BE not ready" 에러 (timeout과 구분).
 *
 * @param {string} baseUrl  http://host:port
 * @param {number} [maxWaitMs=30000]
 * @returns {Promise<{ ok: boolean, waited_ms: number, attempts: number }>}
 */
async function waitForBeReady(baseUrl, maxWaitMs = 30000) {
  const t0 = Date.now();
  let attempts = 0;
  while (Date.now() - t0 < maxWaitMs) {
    attempts += 1;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        return { ok: true, waited_ms: Date.now() - t0, attempts };
      }
    } catch (_) { /* not ready yet — keep polling */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, waited_ms: Date.now() - t0, attempts };
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

  // BE warmup — Phase 8 `--wait`이 컨테이너 started만 보장. lazy mysql2 pool
  // init이 끝나기 전 fetch하면 hang. /health 응답 OK까지 최대 30s 대기.
  const warmup = await waitForBeReady(baseUrl);
  if (!warmup.ok) {
    console.error(`[posttest] BE not ready after ${warmup.waited_ms}ms (${warmup.attempts} attempts)`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { pass: false, error: 'BE not ready (warmup timeout)', baseUrl, warmup },
    });
    return { status: 'FAILED' };
  }
  console.log(`[posttest] BE ready after ${warmup.waited_ms}ms (${warmup.attempts} attempts)`);

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
      output_json: { pass: false, error: e.message, baseUrl, warmup },
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
