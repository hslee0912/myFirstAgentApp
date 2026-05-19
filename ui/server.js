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
 *   ui/routes/deploy.js  — POST /api/{stop-containers,redeploy}
 *   ui/routes/git.js     — GET /api/rollback-preview + POST /api/rollback
 *
 * Concurrency: one orchestrator run at a time (single in-memory slot lives in
 * ui/routes/_context.js#currentRunRef). Subsequent /api/run while busy → 409.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const express = require('express');
require('dotenv').config({ override: true });

const { killHostHolders } = require('../lib/port_killer');
const { readEnv } = require('../lib/env_writer');
const { dockerPreflight } = require('../lib/docker_health');

const envRoutes = require('./routes/env');
const tasksRoutes = require('./routes/tasks');
const runRoutes = require('./routes/run');
const deployRoutes = require('./routes/deploy');
const gitRoutes = require('./routes/git');
const initRoutes = require('./routes/init');

const REQUESTED_PORT = Number(process.env.UI_PORT || 4000);

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const PID_FILE = path.join(ROOT, '.ui-server.pid');

/**
 * Read .env PUBLIC_HOST fresh from disk every call — when the user toggles
 * PUBLIC_HOST in the UI, a subsequent page reload should pick it up without
 * restarting the server. Falls back to 'localhost' (the only sensible
 * placeholder for an HTML link).
 */
function readPublicHost() {
  try {
    const v = readEnv(ENV_PATH).PUBLIC_HOST;
    if (v && v.trim()) return v.trim();
  } catch (_) { /* fall through */ }
  return 'localhost';
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
  // IMPORTANT: sequential, not Promise.all. Linux dual-stack에선 IPv4
  // 0.0.0.0 listen이 동일 port의 IPv6 ::도 자동 점유 → 동시 probe하면
  // 두 번째가 EADDRINUSE (free한 port인데도 not-free 판정). Sequential
  // 하게 close 완료 대기 후 다음 probe.
  return probe('0.0.0.0').then((v4) => v4 && probe('::'));
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

// Serve index.html with __PUBLIC_HOST__ substituted from .env, so the
// initial paint already has the correct host in FE/BE links (no flash of
// "localhost" before /api/env returns). The static handler below catches
// every other asset normally.
function serveIndex(_req, res) {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).send('index.html read error');
    const host = readPublicHost();
    // Replace only the meta-tag placeholder. Keep it conservative — don't
    // do a blanket /__PUBLIC_HOST__/g in case future content uses it.
    const out = html.replace(
      /<meta\s+name="public-host"\s+content="[^"]*"\s*\/?>/,
      `<meta name="public-host" content="${host.replace(/"/g, '&quot;')}" />`,
    );
    res.set('Content-Type', 'text/html; charset=utf-8').send(out);
  });
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(express.static(path.join(__dirname, 'public')));

// Routes are mounted by domain. /api/env, /api/tasks, /api/run are each their
// own router; /api/* (stop-containers, redeploy, reset-db, rollback*) get
// pinned to `/api` so the in-router paths can be the endpoint suffix only.
app.use('/api/env', envRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/run', runRoutes);
app.use('/api', deployRoutes);
app.use('/api', gitRoutes);
app.use('/api', initRoutes);

// ---------------- bootstrap ----------------

/**
 * 이전에 떠 있던 UI 서버를 자동 종료한다 — `.ui-server.pid`에 적힌 PID로 식별.
 *
 * Why: 사용자가 `npm run ui`를 반복 호출할 때마다 옛 process가 옛 port
 * (4005, 4006 …)에 누적되는 게 혼란스러움. 단일 active UI 서버만 살아있도록
 * 새 부팅이 이전 부팅을 정리.
 *
 * 알고리즘:
 *   1. PID file 없거나 비어있으면 skip.
 *   2. 그 PID가 *살아있는지* signal 0으로 체크 (Node convention — 권한만 확인).
 *   3. 살아있으면 SIGTERM → 최대 1초 대기 (50ms × 20회 polling).
 *   4. 그래도 안 죽으면 SIGKILL.
 *   5. PID 재활용 위험: 매우 낮음 (OS가 PID를 즉시 재사용하지 않음). 다른
 *      process를 잘못 죽일 가능성은 무시할 수준이며, 그래도 발생한다면 그
 *      process가 SIGTERM/SIGKILL을 받았을 때 어떻게 반응하는지는 OS가 결정.
 *
 * @returns {Promise<{killed: boolean, pid?: number}>}
 */
async function killPreviousUIServer(pidFile = PID_FILE) {
  if (!fs.existsSync(pidFile)) {
    console.log('[ui]   no previous PID file — fresh start');
    return { killed: false, reason: 'no-pid-file' };
  }
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch (e) {
    console.log(`[ui]   PID file unreadable (${e.code || e.message}) — ignoring`);
    return { killed: false, reason: 'unreadable' };
  }
  if (!pid || pid === process.pid) {
    console.log(`[ui]   PID file points to invalid/self pid=${pid} — ignoring`);
    return { killed: false, reason: 'self-or-invalid', pid };
  }

  console.log(`[ui]   PID file found: pid=${pid}`);

  // signal 0 — process가 살아있고 우리가 죽일 권한이 있는지만 확인.
  try { process.kill(pid, 0); }
  catch (e) {
    console.log(`[ui]   pid=${pid} is stale (${e.code || 'unknown'}) — no kill needed`);
    return { killed: false, reason: 'stale', pid };
  }
  console.log(`[ui]   pid=${pid} is alive — sending SIGTERM`);

  try { process.kill(pid, 'SIGTERM'); }
  catch (e) {
    console.warn(`[ui]   SIGTERM failed (${e.code || e.message}) — continuing to polling`);
  }

  // 최대 1초 (50ms × 20회) 동안 죽는지 polling.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try { process.kill(pid, 0); }
    catch (_) {
      const elapsed = (i + 1) * 50;
      console.log(`[ui]   pid=${pid} terminated after ~${elapsed}ms (SIGTERM 성공)`);
      return { killed: true, reason: 'sigterm', pid };
    }
  }

  // 끝까지 안 죽으면 SIGKILL.
  console.warn(`[ui]   pid=${pid} did NOT respond to SIGTERM in 1s — escalating to SIGKILL`);
  try { process.kill(pid, 'SIGKILL'); } catch (_) { /* 이미 죽었으면 무시 */ }
  return { killed: true, reason: 'sigkill', pid };
}

/**
 * 우리 PID를 PID file에 박는다. 다음 부팅이 이걸 읽어 옛 process를 정리.
 *
 * 정상 종료(SIGINT / SIGTERM / process.exit) 시 cleanupPidFile이 파일 제거.
 * 비정상 종료(kill -9 / 크래시) 시 stale PID가 남아도 다음 부팅이 signal 0
 * 체크로 무시한다.
 */
function writePidFile(pidFile = PID_FILE) {
  try {
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    console.log(`[ui]   PID file written: pid=${process.pid} → ${path.basename(pidFile)}`);
    return true;
  } catch (e) {
    console.warn(`[ui]   PID file write 실패 (non-fatal): ${e.message}`);
    return false;
  }
}

function cleanupPidFile(pidFile = PID_FILE) {
  try {
    if (fs.existsSync(pidFile)) {
      const owner = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (owner === process.pid) {
        fs.unlinkSync(pidFile);
        return true;
      }
    }
  } catch (_) { /* 종료 직전이라 best-effort */ }
  return false;
}

/**
 * Snapshot the current .env to .env.backup at server start.
 *
 * This is the "safety net" half of the rollback restore flow: if the user
 * later hits "Reset to origin/main", rollback rebuilds .env from .env.example
 * (so newly-added keys land with placeholders) and then overlays the values
 * stashed here — secrets and per-user toggles survive across the reset.
 *
 * Idempotent overwrite: every UI start replaces the previous snapshot so
 * the backup always reflects the latest known-good state (the .env the user
 * was actively running with). Skipped if .env doesn't exist (fresh checkout).
 */
function snapshotEnvOnStart() {
  if (!fs.existsSync(ENV_PATH)) {
    console.log('[ui] .env not found — skipping startup backup');
    return;
  }
  const backupPath = path.join(ROOT, '.env.backup');
  try {
    fs.copyFileSync(ENV_PATH, backupPath);
    console.log(`[ui] .env snapshot saved to ${path.basename(backupPath)} (rollback safety net)`);
  } catch (e) {
    console.warn(`[ui] failed to snapshot .env: ${e.message} (non-fatal)`);
  }
}

async function main() {
  const startupT0 = Date.now();
  console.log(`[ui] ━━━ startup begin (pid=${process.pid}, cwd=${process.cwd()}) ━━━`);

  // 1) 이전 UI 서버 자동 종료 (PID file 기반) — `npm run ui`를 반복
  //    호출해도 단일 active 서버만 유지된다. port preflight + fallback에
  //    의존하지 않고 *명시적으로* 옛 process를 정리.
  console.log('[ui] [1/5] previous UI server check (PID file 기반)');
  await killPreviousUIServer();
  writePidFile();
  // 비정상 종료 외 모든 path에서 PID file 청소.
  process.on('exit', cleanupPidFile);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  console.log('[ui] [2/5] .env snapshot (rollback safety net)');
  snapshotEnvOnStart();

  // Docker daemon preflight — Phase 8 (Deploy) + Phase 9 (PostTest) 가
  // docker compose 의존이라 daemon이 죽어 있으면 cycle이 *시작은 되지만*
  // deploy 단계에서 opaque error로 실패한다. 여기서 fail-fast.
  // sudo NOPASSWD (`/etc/sudoers.d/docker-start`)가 등록되어 있으면
  // daemon down 상태에서 자동 `systemctl start docker` 시도.
  console.log('[ui] [3/5] Docker preflight (daemon + compose binary)');
  const dp = dockerPreflight();
  if (!dp.ok) {
    console.error(`[ui]   Docker preflight FAILED — ${dp.reason}`);
    console.error(`[ui]   ${dp.hint}`);
    if (dp.detail) console.error(`[ui]   detail: ${dp.detail}`);
    process.exit(1);
  }
  console.log(`[ui]   Docker preflight OK (compose: ${dp.compose})`);

  // Kill stale node.exe processes holding any canonical project port
  // (UI_PORT + DEPLOY_PORT_FE/BE). D29=A 이후 mysql 컨테이너 없음 —
  // 호스트 MySQL port(3306)는 호스트 서비스라 sweep 대상 아님 (mysqld는
  // 어차피 port_killer의 PROTECTED 셋에서 보호).
  const sweepPorts = [
    REQUESTED_PORT,
    Number(process.env.DEPLOY_PORT_FE || 5173),
    Number(process.env.DEPLOY_PORT_BE || 3001),
  ];
  console.log(`[ui] [4/5] stale port holders sweep — ports=[${sweepPorts.join(', ')}]`);
  const sweepResult = killHostHolders(sweepPorts, 'ui');
  if (sweepResult.killed.length > 0) {
    console.log(`[ui]   killed ${sweepResult.killed.length} stale holder(s): ${sweepResult.killed.map((k) => `pid=${k.pid}(:${k.port})`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 500));
  } else {
    console.log('[ui]   no stale holders');
  }

  console.log(`[ui] [5/5] port preflight + listen (요청 port=${REQUESTED_PORT})`);
  const port = await findFreePort(REQUESTED_PORT);
  if (port !== REQUESTED_PORT) {
    console.log(`[ui]   fallback port=${port}`);
  } else {
    console.log(`[ui]   port ${port} is free`);
  }
  // Bind explicitly to IPv4 0.0.0.0 (not dual-stack). Avoids the failure
  // mode where IPv4 probe says free but a stale IPv6 listener forces
  // app.listen to EADDRINUSE on `:::PORT`. localhost browser access still
  // works — the OS resolves localhost to 127.0.0.1 first.
  const server = app.listen(port, '0.0.0.0', () => {
    const host = readPublicHost();
    const elapsed = Date.now() - startupT0;
    console.log(`[ui] listening on http://${host}:${port}`);
    console.log(`[ui] ━━━ startup complete (${elapsed}ms) ━━━`);
    console.log('[ui] open the URL in a browser to drive the orchestrator');
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
// Lifecycle helpers (killPreviousUIServer, writePidFile, cleanupPidFile)도
// export — tests/ui_server_lifecycle.test.js가 임시 PID file로 검증.
module.exports = {
  app,
  startOrchestrator: runRoutes.startOrchestrator,
  isPortFree,
  findFreePort,
  killPreviousUIServer,
  writePidFile,
  cleanupPidFile,
  PID_FILE,
};
