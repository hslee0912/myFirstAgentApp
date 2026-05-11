/**
 * UI control panel (Express + static HTML).
 *
 * "GUI editor for .env + pipeline runner". Reads from the same MySQL DB that
 * orchestrator/agents already write to. Doesn't introduce a new abstraction —
 * everything here is a thin REST layer over existing artifacts.
 *
 * This file is the bootstrap: port preflight + route mounting. Each route
 * group lives in ui/routes/<domain>.js — see those files for the actual
 * endpoint definitions. The split is by domain so each file stays focused:
 *
 *   ui/routes/env.js    — GET/PUT /api/env
 *   ui/routes/tasks.js  — GET /api/tasks[, /:task_id[, /:task_id/contract]]
 *   ui/routes/run.js    — GET/POST /api/run (orchestrator child process)
 *   ui/routes/deploy.js — POST /api/{stop-containers,redeploy,reset-db}
 *   ui/routes/git.js    — GET /api/rollback-preview + POST /api/rollback
 *
 * Concurrency: one orchestrator run at a time (single in-memory slot lives in
 * ui/routes/_context.js#currentRunRef). Subsequent /api/run while busy → 409.
 */
'use strict';

const net = require('net');
const path = require('path');
const express = require('express');
require('dotenv').config({ override: true });

const { killHostHolders } = require('../lib/port_killer');

const envRoutes = require('./routes/env');
const tasksRoutes = require('./routes/tasks');
const runRoutes = require('./routes/run');
const deployRoutes = require('./routes/deploy');
const gitRoutes = require('./routes/git');

const REQUESTED_PORT = Number(process.env.UI_PORT || 4000);

// ---------------- port preflight (mirror deploy_agent) ----------------

/**
 * Probe `port` on both IPv4 (0.0.0.0) and IPv6 (::) so we don't get bitten
 * by a stale process holding only one stack while the other looks free.
 * Without this, IPv4 probe says "free" → `app.listen(port)` opens dual-stack
 * → EADDRINUSE on the IPv6 side. Both must be free for us to commit.
 */
function isPortFree(port) {
  const probe = (host) => new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch (_) { /* ignore */ }
      resolve(free);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => server.close(() => finish(true)));
    try { server.listen(port, host); } catch (_) { finish(false); }
  });
  return Promise.all([probe('0.0.0.0'), probe('::')]).then(
    ([v4, v6]) => v4 && v6,
  );
}

async function findFreePort(start, max = 20) {
  for (let offset = 0; offset <= max; offset++) {
    const port = start + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) {
      if (offset > 0) {
        console.warn(`[ui] port ${start} in use — falling back to ${port}`);
      }
      return port;
    }
  }
  throw new Error(`[ui] no free port in ${start}..${start + max}`);
}

// ---------------- express app ----------------

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes are mounted by domain. /api/env, /api/tasks, /api/run are each their
// own router; /api/* (stop-containers, redeploy, reset-db, rollback*) get
// pinned to `/api` so the in-router paths can be the endpoint suffix only.
app.use('/api/env', envRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/run', runRoutes);
app.use('/api', deployRoutes);
app.use('/api', gitRoutes);

// ---------------- bootstrap ----------------

async function main() {
  // Kill stale node.exe processes holding any canonical project port
  // (UI_PORT + the three DEPLOY_PORT_*). System services (mysqld, postgres,
  // docker daemon) are explicitly protected. Settle 500ms so the OS
  // actually releases the socket before findFreePort probes.
  const sweepPorts = [
    REQUESTED_PORT,
    Number(process.env.DEPLOY_PORT_FE || 5173),
    Number(process.env.DEPLOY_PORT_BE || 3001),
    Number(process.env.DEPLOY_PORT_DB || 3306),
  ];
  const sweepResult = killHostHolders(sweepPorts, 'ui');
  if (sweepResult.killed.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const port = await findFreePort(REQUESTED_PORT);
  // Bind explicitly to IPv4 0.0.0.0 (not dual-stack). Avoids the failure
  // mode where IPv4 probe says free but a stale IPv6 listener forces
  // app.listen to EADDRINUSE on `:::PORT`. localhost browser access still
  // works — the OS resolves localhost to 127.0.0.1 first.
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[ui] listening on http://localhost:${port}`);
    console.log(`[ui] open the URL in a browser to drive the orchestrator`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[ui] port ${port} taken between preflight and listen — likely a ` +
        `stale node process. Find + kill with:\n` +
        `      Get-NetTCPConnection -LocalPort ${port} | Select OwningProcess\n` +
        `      Stop-Process -Id <pid> -Force`
      );
    } else {
      console.error('[ui] listen error:', err);
    }
    process.exit(1);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[ui] fatal:', e.message);
    process.exit(1);
  });
}

// Preserve the historical export surface so existing tests (and any
// future ones) keep working. `startOrchestrator` now lives in run.js.
module.exports = {
  app,
  startOrchestrator: runRoutes.startOrchestrator,
  isPortFree,
  findFreePort,
};
