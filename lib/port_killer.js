/**
 * Find + kill stale node processes holding TCP ports we care about.
 *
 * Why: PowerShell's Ctrl+C frequently leaves the child `node.exe` of
 * `npm run ui` (and sometimes orchestrator's children) alive, holding 4000.
 * The next `npm run ui` then falls back to 4001 silently. Users open
 * localhost:4000 in the browser and see the OLD server's state. This module
 * sweeps the canonical project ports on UI startup and kills only stale
 * node processes — system services (mysqld, postgres, docker daemon) are
 * explicitly protected, unknown owners are skipped with a warning.
 *
 * Decision boundaries:
 *   - Kill: only `node`/`node.exe` (covers the proper failure mode)
 *   - Protect: mysqld / postgres / mongod / redis-server / docker daemon /
 *              Windows system processes — never killed
 *   - Skip (warn): anything else (IIS, custom user apps, etc.)
 *   - Docker containers themselves are NOT stopped here — Phase 8's
 *     pre-cleanup handles those, and a user might be intentionally keeping
 *     them alive (DEPLOY_TEARDOWN_ON_PASS=off + UI Stop containers button).
 */
'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

const KILLABLE = new Set(['node', 'node.exe']);
const PROTECTED = new Set([
  // Database servers — never touch
  'mysqld', 'mysqld.exe', 'mysql', 'mysql.exe',
  'postgres', 'postgres.exe', 'pg_ctl', 'pg_ctl.exe',
  'mongod', 'mongod.exe',
  'redis-server', 'redis-server.exe',
  'sqlservr', 'sqlservr.exe',
  // Docker daemon / Desktop — kill would break ALL containers, not just ours
  'docker', 'dockerd', 'docker-proxy', 'docker-desktop',
  'com.docker.service', 'com.docker.backend',
  'vpnkit', 'vpnkit.exe',
  // Windows system surface
  'system', 'idle', 'services.exe', 'svchost.exe', 'lsass.exe', 'csrss.exe',
  'wininit.exe', 'winlogon.exe', 'registry',
]);

function isWindows() {
  return os.platform() === 'win32';
}

/**
 * @param {number} port
 * @returns {number[]} unique PIDs holding the port
 *
 * Implementation note: we use `netstat -ano` on Windows instead of
 * Get-NetTCPConnection. PowerShell cmdlets behaved inconsistently under
 * `spawnSync` (returned empty stdout even though the same command from an
 * interactive PowerShell session worked). netstat is built-in on every
 * Windows since XP, no admin required, no PowerShell execution policy
 * involved — bulletproof for this PoC.
 */
function pidsOnPort(port) {
  if (isWindows()) {
    // `netstat -ano | findstr` via cmd. The findstr filter keeps the result
    // small even on busy hosts. Each matching line ends with whitespace + PID.
    const r = spawnSync(
      'cmd',
      ['/c', `netstat -ano -p TCP | findstr LISTENING | findstr :${port}`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    if (!r.stdout) return [];
    const seen = new Set();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.trim().match(/(\d+)\s*$/);
      if (!m) continue;
      // The matched port must actually be the LocalAddress's port. findstr
      // can over-match (e.g. :4000 also matches `:14000`). Verify explicitly.
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || '';
      // local looks like "0.0.0.0:4000" or "[::]:4000" or "127.0.0.1:4000"
      const localPortMatch = local.match(/:(\d+)$/);
      if (!localPortMatch) continue;
      if (Number(localPortMatch[1]) !== port) continue;
      seen.add(Number(m[1]));
    }
    return [...seen];
  }
  // POSIX: `lsof -ti :<port>` (one PID per line)
  const r = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return [];
  return parsePidList(r.stdout);
}

/**
 * @param {string} raw - newline/space-separated PID lines
 * @returns {number[]}
 */
function parsePidList(raw) {
  const seen = new Set();
  for (const tok of String(raw).split(/[\s,]+/)) {
    const n = Number(tok.trim());
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen];
}

/**
 * @param {number} pid
 * @returns {string} lowercase process name, '' if not found
 *
 * Uses `tasklist /FI "PID eq <pid>" /FO CSV /NH` on Windows — same rationale
 * as pidsOnPort (PowerShell-via-spawn flaky, tasklist rock-solid).
 */
function processName(pid) {
  if (isWindows()) {
    const r = spawnSync(
      'cmd',
      ['/c', `tasklist /FI "PID eq ${pid}" /FO CSV /NH`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    if (!r.stdout) return '';
    // CSV header off, sample row: "node.exe","12345","Console","1","123,456 K"
    const m = r.stdout.match(/^"([^"]+)"/);
    return m ? m[1].trim().toLowerCase() : '';
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8', timeout: 5000,
  });
  return (r.stdout || '').trim().toLowerCase();
}

/**
 * Classify a process name into the policy buckets used by killHostHolders.
 * Exported for unit testing — `name` is lower-cased.
 *
 * 'opaque' = name lookup returned empty, which on Windows means either
 *   (a) the process is already dead and only the OS socket remains (TIME_WAIT
 *       / orphaned listener — we can't kill anything; OS reclaims in a few
 *       minutes; fallback port handles it for now), or
 *   (b) the process is admin-owned and tasklist can't see it without elevation
 *       (mysqld service installed via msi often shows this way). Either way,
 *       the safe default is "skip" — never accidentally kill something we
 *       can't even identify.
 *
 * @param {string} name
 * @returns {'killable'|'protected'|'opaque'|'unknown'}
 */
function classify(name) {
  const n = String(name || '').toLowerCase();
  if (n === '') return 'opaque';
  if (KILLABLE.has(n)) return 'killable';
  if (PROTECTED.has(n)) return 'protected';
  return 'unknown';
}

/**
 * @param {number} pid
 * @returns {boolean} true on kill success
 */
function killPid(pid) {
  if (isWindows()) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    return r.status === 0;
  }
  const r = spawnSync('kill', ['-9', String(pid)], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

/**
 * Sweep `ports`, kill stale node processes holding them, leave system
 * services alone. Pure side-effect — return a structured summary so callers
 * (and tests) can log / assert.
 *
 * @param {number[]} ports
 * @param {string} [label] - prefix used in console messages, e.g. '[ui]'
 * @returns {{ killed: Array, protectedHits: Array, unknown: Array }}
 */
function killHostHolders(ports, label = 'startup') {
  const killed = [];
  const protectedHits = [];
  const unknown = [];

  const opaque = [];
  for (const port of ports) {
    const pids = pidsOnPort(port);
    for (const pid of pids) {
      const name = processName(pid);
      const bucket = classify(name);
      const entry = { pid, name: name || '(opaque)', port };
      if (bucket === 'killable') {
        const ok = killPid(pid);
        if (ok) {
          console.warn(`[${label}] killed ${entry.name} (pid=${pid}) holding :${port}`);
          killed.push(entry);
        } else {
          console.warn(`[${label}] failed to kill ${entry.name} (pid=${pid}) on :${port}`);
        }
      } else if (bucket === 'protected') {
        console.warn(
          `[${label}] PROTECTED ${entry.name} (pid=${pid}) on :${port} — not killed. ` +
          'If you want this port free, stop it yourself (e.g. service stop).'
        );
        protectedHits.push(entry);
      } else if (bucket === 'opaque') {
        console.warn(
          `[${label}] opaque holder on :${port} (pid=${pid}, name lookup failed) — ` +
          'process is already dead (orphaned TIME_WAIT socket) or admin-owned. ' +
          'Not killed. Fallback port will be used; OS reclaims the socket in a few minutes.'
        );
        opaque.push(entry);
      } else {
        console.warn(
          `[${label}] unknown holder ${entry.name} (pid=${pid}) on :${port} — not killed ` +
          '(only node.exe is auto-killed). Resolve manually if it conflicts.'
        );
        unknown.push(entry);
      }
    }
  }

  return { killed, protectedHits, opaque, unknown };
}

module.exports = {
  killHostHolders,
  pidsOnPort,
  processName,
  killPid,
  classify,
  parsePidList,
  KILLABLE,
  PROTECTED,
};
