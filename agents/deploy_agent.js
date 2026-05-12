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

const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const logger = require('../lib/logger');
const { cleanupOurContainers } = require('../lib/container_cleanup');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'lib', 'stack_templates', 'docker-compose.yml');

// D29=A: mysql 컨테이너 폐지. 도구/비즈니스 모두 호스트 MySQL을 공유.
const SERVICES = ['be', 'fe'];
const PORT_FALLBACK_MAX_OFFSET = 20;

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
    be: Number(process.env.DEPLOY_PORT_BE || 3001),
    fe: Number(process.env.DEPLOY_PORT_FE || 5173),
  };
}

const PORT_ENV_KEY = { be: 'DEPLOY_PORT_BE', fe: 'DEPLOY_PORT_FE' };

// ---------------- host MySQL ping (D29=A) ----------------

/**
 * BE 컨테이너가 host.docker.internal:DB_PORT로 호스트 MySQL에 접속한다.
 * compose up이 실패하기 전에 *호스트 MySQL이 살아있는지*를 우리가 먼저 검증해
 * 친절한 에러 메시지를 준다 (mysql2 driver의 ECONNREFUSED 보다 명확).
 *
 * 단순 TCP probe — 인증/스키마는 검증 안 함. listen 중인 process가 있으면 OK.
 *
 * @returns {Promise<{ok: boolean, host: string, port: number, error?: string}>}
 */
function pingHostMysql() {
  const host = process.env.DB_HOST || 'localhost';
  const port = Number(process.env.DB_PORT || 3306);
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve({ ok, host, port, error });
    };
    sock.setTimeout(2000);
    sock.once('connect', () => finish(true));
    sock.once('error', (e) => finish(false, e.message));
    sock.once('timeout', () => finish(false, 'connect timeout (2s)'));
    sock.connect(port, host);
  });
}

// ---------------- port availability + fallback ----------------

/**
 * Parse `docker ps --format '{{.Ports}}'` output into a Set of host ports
 * currently published by any running container. Robust to Windows/Linux
 * differences (matches `:<port>->` regardless of host address).
 *
 * Why this matters: Docker on Windows lets Node bind to a port that
 * `docker ps` reports as published (different Layer), so the OS-level
 * net.createServer probe alone gives false positives. Compose `up` then
 * fails with "port is already allocated". This pre-skips those ports.
 *
 * If the docker CLI is missing or the call fails, returns an empty Set so
 * the OS-level probe remains the only signal — graceful degradation.
 *
 * @returns {Set<number>}
 */
function dockerPublishedPorts() {
  try {
    const r = spawnSync('docker', ['ps', '--format', '{{.Ports}}'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return new Set();
    const ports = new Set();
    const re = /:(\d+)->/g;
    let m;
    while ((m = re.exec(r.stdout)) !== null) {
      ports.add(Number(m[1]));
    }
    return ports;
  } catch (_) {
    return new Set();
  }
}

/**
 * Try to bind a server to `port` on 0.0.0.0. Returns true if the bind
 * succeeds (port is free) and false if EADDRINUSE / EACCES occurs.
 * The probe is short-lived; the listener is closed before resolving.
 *
 * Note: on Windows, Docker-published ports may still pass this probe.
 * Callers should consult `dockerPublishedPorts()` as the first filter.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch (_) { /* ignore */ }
      resolve(free);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => {
      server.close(() => finish(true));
    });
    try {
      server.listen(port, '0.0.0.0');
    } catch (_) {
      finish(false);
    }
  });
}

/**
 * Probe `start, start+1, ..., start+maxOffset` and return the first free one.
 * Throws when none are free within the window.
 *
 * Skips Docker-published ports up front (cheap O(1) Set lookup), then falls
 * through to the OS-level net.createServer probe.
 *
 * @param {number} start
 * @param {string} label - 'mysql' | 'be' | 'fe' (drives the .env hint)
 * @param {number} [maxOffset]
 * @param {Set<number>} [dockerPorts] - host ports already taken by docker
 * @returns {Promise<number>}
 */
async function findFreePort(start, label, maxOffset = PORT_FALLBACK_MAX_OFFSET, dockerPorts = new Set()) {
  for (let offset = 0; offset <= maxOffset; offset++) {
    const port = start + offset;
    if (dockerPorts.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) {
      if (offset > 0) {
        const envKey = PORT_ENV_KEY[label] || `DEPLOY_PORT_${label.toUpperCase()}`;
        console.warn(
          `[deploy] port ${start} (${label}) is in use — falling back to ${port}. ` +
          `Set ${envKey}=${port} in .env to persist.`
        );
      }
      return port;
    }
  }
  throw new Error(
    `[deploy] No free port found for ${label} in range ${start}..${start + maxOffset}`
  );
}

/**
 * Resolve every Deploy host port, falling back to the next free port on
 * conflict (host MySQL on 3306, stale docker container on 3307, etc.).
 * Mutates process.env so docker compose substitution and Phase 9 PostTest
 * see the resolved values consistently. Container-internal ports unaffected.
 *
 * Two layers of conflict detection:
 *   1. `docker ps` published ports — covers stale containers from previous
 *      Deploy runs that were left alive (D6=B FAIL branch).
 *   2. OS-level net.listen probe — covers non-docker conflicts (host MySQL,
 *      another local process).
 *
 * @param {{be:number, fe:number}} requested
 * @returns {Promise<{be:number, fe:number, changed:boolean}>}
 */
async function resolvePortsWithFallback(requested) {
  const dockerPorts = dockerPublishedPorts();
  const be = await findFreePort(requested.be, 'be', PORT_FALLBACK_MAX_OFFSET, dockerPorts);
  const fe = await findFreePort(requested.fe, 'fe', PORT_FALLBACK_MAX_OFFSET, dockerPorts);
  process.env.DEPLOY_PORT_BE = String(be);
  process.env.DEPLOY_PORT_FE = String(fe);
  const changed = be !== requested.be || fe !== requested.fe;
  return { be, fe, changed };
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
  const requestedPorts = getPorts();

  const run_id = await logger.startRun({
    task_id,
    agent_name: 'Deploy',
    input_json: { mode, ports: requestedPorts, timeoutMs, compose_file: COMPOSE_FILE },
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

  // D29=A: host MySQL ping. BE 컨테이너가 host.docker.internal:DB_PORT로
  // 호스트 MySQL에 접속하므로 그 host MySQL이 살아있어야 한다. compose up
  // 후 mysql2 driver의 모호한 ECONNREFUSED 보다 여기서 명시적 에러로 잡음.
  const mysqlPing = await pingHostMysql();
  if (!mysqlPing.ok) {
    const msg =
      `호스트 MySQL이 응답하지 않음 (${mysqlPing.host}:${mysqlPing.port}): ${mysqlPing.error}. ` +
      '.env의 DB_HOST/DB_PORT 확인, MySQL 서비스 기동 여부 확인.';
    console.error(`[deploy] ${msg}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { exit_code: -1, failed_stage: 'host_mysql_ping', error: msg },
    });
    return { status: 'FAILED' };
  }

  // D6=B+: pre-cleanup. Sweep EVERY container this PoC has managed (by label
  // first, by name+image convention for legacy containers without the label).
  // This is broader than the old `compose down` (which only touched the
  // current project) and is what prevents port drift across cycles —
  // finalize-*, verify-port-fix-* etc. are removed here so the next port
  // preflight finds 5173/3001/3306 free.
  console.log('[deploy] pre-cleanup: sweeping managed + legacy containers');
  cleanupOurContainers();

  // Port pre-flight: probe each host port and fall back to the next free one.
  // After the sweep above, the only conflicts left should be host-level
  // services (host MySQL on 3306, host Vite dev server, etc.) — those still
  // trigger fallback. process.env is mutated so docker compose substitution
  // + Phase 9 PostTest see the resolved port consistently.
  let ports;
  try {
    ports = await resolvePortsWithFallback(requestedPorts);
    if (ports.changed) {
      console.log(
        `[deploy] resolved ports: be=${ports.be} fe=${ports.fe} ` +
        `(requested be=${requestedPorts.be} fe=${requestedPorts.fe})`
      );
    }
  } catch (e) {
    console.error(`[deploy] ${e.message}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: {
        exit_code: -1,
        failed_stage: 'port_preflight',
        error: e.message,
        requested_ports: requestedPorts,
      },
    });
    return { status: 'FAILED' };
  }

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
      services: { be: 'running', fe: 'running' },
      ports,
      requested_ports: requestedPorts,
      ports_changed: ports.changed,
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

module.exports = {
  run,
  teardown,
  isPortFree,
  findFreePort,
  resolvePortsWithFallback,
  dockerPublishedPorts,
  pingHostMysql,
};
