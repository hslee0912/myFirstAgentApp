/**
 * Container cleanup — sweep every container this PoC has ever spawned so the
 * next Phase 8 cycle can claim the canonical host ports (5173/3001/3306).
 *
 * Two-tier identification:
 *
 *   1. **Label** (`com.myfirstagentapp.managed=true`)
 *      Going forward, every container compose creates carries this label
 *      (added in `lib/stack_templates/docker-compose.yml`). This is the
 *      authoritative match.
 *
 *   2. **Convention fallback** — for legacy containers (e.g. the
 *      `finalize-*` / `verify-port-fix-*` left over from before labels
 *      existed). Both name AND image must match:
 *        FE:    name ~ `*-fe-<n>`     AND  image endsWith `-fe`
 *        BE:    name ~ `*-be-<n>`     AND  image endsWith `-be`
 *        MySQL: name ~ `*-mysql-<n>`  AND  image startsWith `mysql:`
 *      Both gates required so we don't false-positive on a user's
 *      unrelated `nginx-fe-1` container or a stranger's standalone
 *      `mysql:8` deployment.
 *
 * Pure helpers (matchesOurConvention, parseDockerPsRows, selectVictims) are
 * exported for unit testing. `cleanupOurContainers()` is the side-effecting
 * entry called by deploy_agent's pre-cleanup.
 */
'use strict';

const { spawnSync } = require('child_process');

const MANAGED_LABEL = 'com.myfirstagentapp.managed';
const MANAGED_LABEL_VALUE = 'true';

const NAME_PATTERNS = {
  fe:    /-fe-\d+$/,
  be:    /-be-\d+$/,
  mysql: /-mysql-\d+$/,
};

/**
 * Match by convention: name AND image must both fit one of the three
 * service patterns. Case-insensitive. Returns false for any null/empty.
 *
 * @param {string} name
 * @param {string} image
 * @returns {boolean}
 */
function matchesOurConvention(name, image) {
  if (!name || !image) return false;
  const n = String(name).toLowerCase();
  const i = String(image).toLowerCase();

  if (NAME_PATTERNS.fe.test(n)    && i.endsWith('-fe'))    return true;
  if (NAME_PATTERNS.be.test(n)    && i.endsWith('-be'))    return true;
  if (NAME_PATTERNS.mysql.test(n) && i.startsWith('mysql:')) return true;
  return false;
}

/**
 * Parse `docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "com.myfirstagentapp.managed"}}'`
 * stdout into rows. Tabs are the separator; missing 4th column → isManaged=false.
 *
 * @param {string} stdout
 * @returns {Array<{id:string,name:string,image:string,isManaged:boolean}>}
 */
function parseDockerPsRows(stdout) {
  const out = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [id, name, image, label = ''] = parts;
    out.push({
      id: (id || '').trim(),
      name: (name || '').trim(),
      image: (image || '').trim(),
      isManaged: (label || '').trim() === MANAGED_LABEL_VALUE,
    });
  }
  return out;
}

/**
 * Pick rows we should remove. Label wins → reason='label'; else convention
 * → reason='convention'; else preserved.
 *
 * @param {Array} rows
 * @returns {Array<{id,name,image,isManaged,reason:'label'|'convention'}>}
 */
function selectVictims(rows) {
  const victims = [];
  for (const r of (rows || [])) {
    if (r.isManaged) {
      victims.push({ ...r, reason: 'label' });
    } else if (matchesOurConvention(r.name, r.image)) {
      victims.push({ ...r, reason: 'convention' });
    }
  }
  return victims;
}

/**
 * Side-effecting cleanup. Lists containers via `docker ps -a`, selects
 * victims, calls `docker rm -f` on them in one batch, then prunes orphaned
 * networks. Returns a summary so the deploy_agent log line can include it.
 *
 * Best-effort — if `docker ps` fails (Docker not running), we warn and
 * return empty. Phase 8's existing Docker-check will then catch the missing
 * daemon explicitly.
 *
 * @returns {{ victims: Array, removed: string[], dockerAvailable: boolean }}
 */
function cleanupOurContainers() {
  const ps = spawnSync(
    'docker',
    [
      'ps', '-a',
      '--format',
      `{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "${MANAGED_LABEL}"}}`,
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );

  if (ps.status !== 0) {
    console.warn('[deploy] cleanup: docker ps failed; skipping (will surface in Docker check)');
    return { victims: [], removed: [], dockerAvailable: false };
  }

  const rows = parseDockerPsRows(ps.stdout);
  const victims = selectVictims(rows);
  if (victims.length === 0) {
    return { victims: [], removed: [], dockerAvailable: true };
  }

  console.log(`[deploy] cleanup: removing ${victims.length} stale container(s)`);
  for (const v of victims) {
    console.log(`  - ${v.name} (${v.image}) via ${v.reason}`);
  }

  const ids = victims.map((v) => v.id);
  spawnSync('docker', ['rm', '-f', ...ids], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  // Orphaned networks left behind by removed containers.
  spawnSync('docker', ['network', 'prune', '-f'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });

  return { victims, removed: ids, dockerAvailable: true };
}

module.exports = {
  matchesOurConvention,
  parseDockerPsRows,
  selectVictims,
  cleanupOurContainers,
  MANAGED_LABEL,
  MANAGED_LABEL_VALUE,
  NAME_PATTERNS,
};
