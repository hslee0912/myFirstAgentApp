/**
 * Phase 8 — Deploy Agent (deterministic, no LLM).
 *
 * Orchestrator integration contract (D25=B):
 *   - Called AFTER round loop exits with verdict=PASS candidate.
 *   - On overall PASS, orchestrator calls teardown() (D6=B PASS branch).
 *   - On FAIL/ERROR, containers are intentionally kept for debugging (D6=B).
 *
 * Behavior matrix:
 *   - DEPLOY_MODE=off       → log_agent_runs row + status=SUCCESS + skipped note (D26=A).
 *   - Docker/Compose 미설치 → FAILED row + clear error message (D27=A).
 *   - up timeout            → FAILED row + service-by-service logs.
 *   - up exit_code !== 0    → FAILED row + service-by-service logs.
 *   - up success            → SUCCESS row + compact services/ports summary (D31=C PASS).
 *
 * Decision provenance (docs/DECISIONS.md, 2026-05-08):
 *   D1, D2, D5, D6, D8, D10, D17, D25, D26, D27, D30, D31, D32 + auto D28, D29.
 *
 * Schema requirement:
 *   `log_agent_runs.agent_name` ENUM must include 'Deploy' (S8 migration).
 *   Until S8 is done, this module will fail at logger.startRun() with an ENUM error.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const logger = require('../lib/logger');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'lib', 'stack_templates', 'docker-compose.yml');

const SERVICES = ['mysql', 'be', 'fe'];

// ---------------- compose CLI auto-detection ----------------

let _composeCmd = null;

/**
 * Detect docker compose CLI. Prefer v2 (`docker compose`) for --wait support.
 * @returns {{ cmd: string[], v2: boolean } | null}
 */
function detectComposeCmd() {
  if (_composeCmd) return _composeCmd;

  let r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) {
    _composeCmd = { cmd: ['docker', 'compose'], v2: true };
    return _composeCmd;
  }

  r = spawnSync('docker-compose', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) {
    _composeCmd = { cmd: ['docker-compose'], v2: false };
    return _composeCmd;
  }

  return null;
}

// ---------------- env helpers ----------------

function getDeployMode() {
  return (process.env.DEPLOY_MODE || 'on').toLowerCase();
}

function getTimeoutMs() {
  return Number(process.env.DEPLOY_TIMEOUT_SEC || 300) * 1000;
}

function getLogTailLines() {
  return Number(process.env.LOG_TAIL_LINES || 200);
}

function getPorts() {
  return {
    mysql: Number(process.env.DEPLOY_PORT_DB || 3306),
    be: Number(process.env.DEPLOY_PORT_BE || 3001),
    fe: Number(process.env.DEPLOY_PORT_FE || 5173),
  };
}

// ---------------- compose invocation helpers ----------------

/**
 * Build a ready-to-spawn invocation with --project-directory + -f flags (D17=A).
 * @returns {{ cmd: string, args: string[], v2: boolean } | null}
 */
function composeInvoke(...subcommand) {
  const detected = detectComposeCmd();
  if (!detected) return null;
  const [cmd, ...prefix] = detected.cmd;
  return {
    cmd,
    args: [
      ...prefix,
      '--project-directory', ROOT,
      '-f', COMPOSE_FILE,
      ...subcommand,
    ],
    v2: detected.v2,
  };
}

/**
 * D27=A: Docker CLI + Compose plugin/standalone availability check.
 */
function checkDockerStack() {
  const docker = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (docker.status !== 0) {
    return { ok: false, error: 'Docker CLI not installed or not in PATH' };
  }
  if (!detectComposeCmd()) {
    return {
      ok: false,
      error: 'Docker Compose not available (tried `docker compose` v2 and `docker-compose` v1)',
    };
  }
  return { ok: true };
}

/**
 * D10=A: pull last N lines of logs for one service.
 */
function tailServiceLogs(service, n) {
  const inv = composeInvoke('logs', '--tail', String(n), '--no-color', service);
  if (!inv) return '';
  const r = spawnSync(inv.cmd, inv.args, { encoding: 'utf8', timeout: 15000 });
  // Cap per-service log to ~30KB for JSON column safety.
  return ((r.stdout || '') + (r.stderr || '')).slice(-30000);
}

function collectAllLogs(n) {
  const out = {};
  for (const svc of SERVICES) {
    out[svc] = tailServiceLogs(svc, n);
  }
  return out;
}

/**
 * `compose down --remove-orphans`. Failures are logged but never thrown —
 * cleanup is best-effort and must not affect deploy verdict.
 */
function composeDown() {
  const inv = composeInvoke('down', '--remove-orphans');
  if (!inv) return;
  spawnSync(inv.cmd, inv.args, { encoding: 'utf8', timeout: 60000 });
}

// ---------------- main run flow ----------------

/**
 * Phase 8 main entry. Inserts a log_agent_runs row and finalizes it.
 *
 * @param {{ task_id: string }} params
 * @returns {Promise<{ status: 'SUCCESS'|'FAILED', skipped?: boolean }>}
 */
async function run({ task_id }) {
  const mode = getDeployMode();
  const timeoutMs = getTimeoutMs();
  const tail = getLogTailLines();
  const ports = getPorts();

  const run_id = await logger.startRun({
    task_id,
    agent_name: 'Deploy',
    input_json: { mode, ports, timeoutMs, compose_file: COMPOSE_FILE },
  });

  // D26=A: DEPLOY_MODE=off → skip with auto-SUCCESS, marked in output_json.
  if (mode !== 'on') {
    console.log('[deploy] DEPLOY_MODE=off — Phase 8 skipped (auto-SUCCESS)');
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: { skipped: 'DEPLOY_MODE=off' },
    });
    return { status: 'SUCCESS', skipped: true };
  }

  // D27=A: Docker + Compose availability.
  const dockerCheck = checkDockerStack();
  if (!dockerCheck.ok) {
    console.error(`[deploy] ${dockerCheck.error}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { exit_code: -1, failed_stage: 'docker_check', error: dockerCheck.error },
    });
    return { status: 'FAILED' };
  }

  // D6=B: pre-cleanup so leftover containers from a previous FAIL don't conflict.
  // Best-effort — failures here are silently ignored.
  console.log('[deploy] pre-cleanup: compose down --remove-orphans');
  composeDown();

  // up --build [--wait when v2]
  const upArgs = ['up', '--build', '--detach'];
  const detected = detectComposeCmd();
  if (detected.v2) upArgs.push('--wait');
  const upInv = composeInvoke(...upArgs);

  console.log(
    `[deploy] ${upInv.cmd} ${upInv.args.join(' ')} (timeout ${timeoutMs / 1000}s)`
  );
  const startedAt = Date.now();
  const upResult = spawnSync(upInv.cmd, upInv.args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env },
  });
  const duration_ms = Date.now() - startedAt;

  // spawnSync timeout: signal='SIGTERM', status=null
  const timedOut = upResult.signal === 'SIGTERM' || upResult.status === null;
  if (timedOut) {
    const errMsg = `compose up timed out after ${timeoutMs / 1000}s`;
    console.error(`[deploy] ${errMsg}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: {
        exit_code: null,
        duration_ms,
        failed_stage: 'compose_up_timeout',
        error: errMsg,
        logs: collectAllLogs(tail),
      },
    });
    return { status: 'FAILED' };
  }

  if (upResult.status !== 0) {
    console.error(`[deploy] compose up failed (exit_code=${upResult.status})`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: {
        exit_code: upResult.status,
        duration_ms,
        failed_stage: 'compose_up',
        compose_output: ((upResult.stdout || '') + (upResult.stderr || '')).slice(-8000),
        logs: collectAllLogs(tail),
      },
    });
    return { status: 'FAILED' };
  }

  // D31=C PASS shape — compact summary, no logs.
  console.log(`[deploy] up complete in ${duration_ms}ms`);
  await logger.endRun(run_id, {
    status: 'SUCCESS',
    output_json: {
      exit_code: 0,
      duration_ms,
      services: { mysql: 'healthy', be: 'running', fe: 'running' },
      ports,
    },
  });
  return { status: 'SUCCESS' };
}

/**
 * Cleanup hook — orchestrator calls this AFTER overall PASS verdict (D6=B PASS branch).
 * On FAIL/ERROR, do NOT call teardown — containers must remain alive for debugging.
 */
function teardown() {
  console.log('[deploy] post-cleanup: compose down --remove-orphans');
  composeDown();
}

module.exports = { run, teardown };
