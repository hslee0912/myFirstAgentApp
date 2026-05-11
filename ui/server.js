/**
 * UI control panel (Express + static HTML).
 *
 * "GUI editor for .env + pipeline runner". Reads from the same MySQL DB that
 * orchestrator/agents already write to. Doesn't introduce a new abstraction —
 * everything here is a thin REST layer over existing artifacts.
 *
 * Endpoints:
 *   GET    /api/env                — UI-editable .env keys + current values
 *   PUT    /api/env                — atomic .env update for allowlisted keys
 *   GET    /api/tasks              — recent log_agent_decisions (most recent N)
 *   GET    /api/tasks/:task_id     — decision + task_states + per-agent runs
 *   GET    /api/tasks/:task_id/contract — current shared/api_contract.json (expanded)
 *   POST   /api/run                — spawn `node agents/orchestrator.js`, return task_id
 *   POST   /api/reset-db           — invoke `node lib/reset_db.js`
 *   GET    /                       — static index.html
 *
 * Concurrency: one orchestrator run at a time (single in-memory slot).
 * Subsequent /api/run while busy returns 409.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const express = require('express');
require('dotenv').config({ override: true });

const { readEnv, updateEnv, UI_EDITABLE_KEYS } = require('../lib/env_writer');
const { normalizeContract } = require('../lib/api_test');
const deployAgent = require('../agents/deploy_agent');
const db = require('../lib/db');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const REQUESTED_PORT = Number(process.env.UI_PORT || 4000);

// ---------------- single-run slot ----------------

let currentRun = null; // { task_id, pid, startedAt }

function startOrchestrator(userPrompt) {
  if (currentRun) return { ok: false, error: 'busy', current: currentRun };
  const args = [path.join(ROOT, 'agents', 'orchestrator.js')];
  if (userPrompt && userPrompt.trim()) args.push(userPrompt);

  const child = spawn('node', args, {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const logChunks = [];
  let detectedTaskId = null;
  const onData = (buf) => {
    const s = buf.toString();
    logChunks.push(s);
    if (!detectedTaskId) {
      const m = s.match(/task_id=([a-z0-9_]+)/i);
      if (m) {
        detectedTaskId = m[1];
        currentRun.task_id = detectedTaskId;
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  currentRun = {
    task_id: null,
    pid: child.pid,
    startedAt: Date.now(),
    log: () => logChunks.join('').slice(-30000),
  };

  child.on('exit', (code) => {
    if (currentRun && currentRun.pid === child.pid) {
      currentRun.finishedAt = Date.now();
      currentRun.exitCode = code;
      // Keep last run visible for ~10s so polling picks it up, then clear.
      setTimeout(() => {
        if (currentRun && currentRun.pid === child.pid) currentRun = null;
      }, 10_000);
    }
  });

  return { ok: true, pid: child.pid };
}

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

app.get('/api/env', (_req, res) => {
  const all = readEnv(ENV_PATH);
  const editable = {};
  for (const k of UI_EDITABLE_KEYS) editable[k] = all[k] ?? '';
  res.json({ editable, editableKeys: UI_EDITABLE_KEYS });
});

app.put('/api/env', (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const k of Object.keys(body)) {
    if (!UI_EDITABLE_KEYS.includes(k)) {
      return res.status(400).json({ error: `key '${k}' not in allowlist` });
    }
    updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no keys to update' });
  }
  const result = updateEnv(ENV_PATH, updates);
  res.json({ ok: true, ...result });
});

app.get('/api/tasks', async (_req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, task_id, final_verdict, final_result_text, created_at, updated_at ' +
      'FROM log_agent_decisions ORDER BY id DESC LIMIT 20'
    );
    res.json({ tasks: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tasks/:task_id', async (req, res) => {
  try {
    const { task_id } = req.params;
    const [decisions, runs] = await Promise.all([
      db.query(
        'SELECT id, task_id, final_verdict, final_result_text, created_at, updated_at ' +
        'FROM log_agent_decisions WHERE task_id = ? LIMIT 1',
        [task_id],
      ),
      db.query(
        'SELECT id, agent_name, target, status, input_json, output_json, started_at, ended_at ' +
        'FROM log_agent_runs WHERE task_id = ? ORDER BY id ASC',
        [task_id],
      ),
    ]);
    const decision = decisions[0] || null;
    let states = [];
    if (decision) {
      states = await db.query(
        'SELECT id, target, status, retry_count, failed_stage, fix_instructions, stage_logs, ' +
        'created_at, updated_at FROM log_task_state WHERE decision_id = ? ORDER BY target ASC',
        [decision.id],
      );
    }
    res.json({ decision, states, runs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tasks/:task_id/contract', (_req, res) => {
  const p = path.join(ROOT, 'shared', 'api_contract.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'no api_contract.json' });
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const expanded = normalizeContract(raw, {
      routerDir: path.join(ROOT, 'shared', 'router'),
    });
    res.json({ contract: expanded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/run', (_req, res) => {
  res.json({ running: currentRun !== null, current: currentRun
    ? {
        task_id: currentRun.task_id,
        pid: currentRun.pid,
        startedAt: currentRun.startedAt,
        finishedAt: currentRun.finishedAt || null,
        exitCode: currentRun.exitCode ?? null,
        logTail: currentRun.log ? currentRun.log() : '',
      }
    : null });
});

app.post('/api/run', (req, res) => {
  const prompt = (req.body && req.body.prompt) || '';
  const result = startOrchestrator(prompt);
  if (!result.ok) return res.status(409).json(result);
  res.json({ ok: true, pid: result.pid });
});

app.post('/api/stop-containers', (_req, res) => {
  try {
    deployAgent.teardown();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/reset-db', async (_req, res) => {
  const child = spawn('node', [path.join(ROOT, 'lib', 'reset_db.js')], {
    cwd: ROOT,
    env: { ...process.env },
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });
  child.on('exit', (code) => {
    if (code === 0) res.json({ ok: true, output: out.slice(-2000) });
    else res.status(500).json({ ok: false, code, output: out.slice(-2000) });
  });
});

// ---------------- bootstrap ----------------

async function main() {
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

module.exports = { app, startOrchestrator, isPortFree, findFreePort };
