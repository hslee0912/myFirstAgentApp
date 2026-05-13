/**
 * Contract sync — static analysis to verify BE/src/ implements every endpoint
 * declared in shared/api_contract.json. Pure logic (no DB, no LLM, no fetch).
 *
 * Decision provenance (docs/DECISIONS.md, 2026-05-14):
 *   D36 — Phase 2.7 ContractSync Agent. Static (regex-based) diff of contract
 *         endpoints vs Express route declarations. Runs inside round loop so
 *         FAIL routes BE back into retry flow via log_task_state. Cheap
 *         (~0.1s); always ON, *independent of VALIDATION_MODE* (it's a
 *         safety guard, same class as `validatePaths` / `protectedConfigFiles`).
 *
 * Why static instead of runtime?
 *   - PostTest (Phase 9) uses fetch → needs Deploy(`docker compose up`, ~30s)
 *     → can't go inside round loop without retry-time blow-up.
 *   - 90%+ contract↔code mismatch is endpoint *existence*, which a regex pass
 *     catches without any server boot.
 *   - Runtime schema/body checks stay in PostTest (Phase 9, outside loop).
 *
 * Inputs:
 *   - shared/api_contract.json (split index → normalizeContract walks router/)
 *   - BE/src/server.js                  (where `app.use('<prefix>', router)` lives)
 *   - BE/src/routes/*.js                (where `router.<method>('<sub>', ...)` lives)
 *
 * Caveats (intentional PoC scope):
 *   - Regex-based, not full AST. Catches the conventional Express patterns
 *     the BE Agent is *taught* to emit (rules/be.md). Dynamic require/use
 *     via runtime-computed variables would slip through.
 *   - Path params normalized to `:_param` for diff so the contract can say
 *     either `/users/:id` (Express) or `/users/{id}` (OpenAPI) without false
 *     mismatches. Method is compared case-insensitively.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeContract } = require('./api_test');

// ---------------- contract loading ----------------

/**
 * Load + normalize `shared/api_contract.json` into a flat endpoint list.
 *
 * @param {{contractPath: string, routerDir?: string}} params
 * @returns {{endpoints: Array<{name?: string, method: string, path: string}>, error?: string}}
 *   On read/parse failure → `{endpoints: [], error}` so callers can decide
 *   whether the absence is fatal or pass-through (e.g. round 1 before CC).
 */
function loadContractEndpoints({ contractPath, routerDir }) {
  if (!fs.existsSync(contractPath)) {
    return { endpoints: [], error: `api_contract not found: ${contractPath}` };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (e) {
    return { endpoints: [], error: `api_contract parse error: ${e.message}` };
  }
  let normalized;
  try {
    normalized = normalizeContract(raw, { routerDir });
  } catch (e) {
    return { endpoints: [], error: `api_contract normalize error: ${e.message}` };
  }
  const out = [];
  for (const ep of normalized.endpoints || []) {
    if (!ep || !ep.path || !ep.method) continue;
    out.push({
      name: ep.name || null,
      method: String(ep.method).toUpperCase(),
      path: String(ep.path),
    });
  }
  return { endpoints: out };
}

// ---------------- BE route extraction ----------------

const RE_REQUIRE =
  /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_APP_USE =
  /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g;
const RE_ROUTER_METHOD =
  /router\.(get|post|put|delete|patch|head|options)\(\s*['"]([^'"]+)['"]/gi;

/**
 * Resolve `./routes/auth_routes` (the require path) → absolute file path.
 * Tries `.js` suffix and `index.js` fallback.
 */
function resolveRequirePath(serverFile, modulePath) {
  if (!modulePath.startsWith('.')) return null; // only relative
  const base = path.resolve(path.dirname(serverFile), modulePath);
  const candidates = [
    base + '.js',
    path.join(base, 'index.js'),
    base,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Parse a Express server.js into the set of mounted routers:
 *   [{prefix, varName, file}]
 *
 * Comments are stripped (line + block) before matching so commented-out
 * `app.use(...)` lines are ignored. Strings inside code that happen to
 * contain `app.use(...)` are accepted as false positives (PoC scope).
 *
 * @returns {{mounts: Array<{prefix:string, varName:string, file:string|null}>, requires: Record<string,string>}}
 */
function parseServerFile(serverFile) {
  const src = fs.readFileSync(serverFile, 'utf8');
  // strip block + line comments
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

  const requires = {};
  let m;
  RE_REQUIRE.lastIndex = 0;
  while ((m = RE_REQUIRE.exec(code)) !== null) {
    requires[m[1]] = m[2];
  }

  const mounts = [];
  RE_APP_USE.lastIndex = 0;
  while ((m = RE_APP_USE.exec(code)) !== null) {
    const prefix = m[1];
    const varName = m[2];
    const requirePath = requires[varName];
    const file = requirePath ? resolveRequirePath(serverFile, requirePath) : null;
    mounts.push({ prefix, varName, file });
  }
  return { mounts, requires };
}

/**
 * Parse a route file (e.g. BE/src/routes/auth_routes.js) into the list of
 * declared subpaths: [{method, subpath}].
 */
function parseRouteFile(routeFile) {
  const src = fs.readFileSync(routeFile, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const out = [];
  let m;
  RE_ROUTER_METHOD.lastIndex = 0;
  while ((m = RE_ROUTER_METHOD.exec(code)) !== null) {
    out.push({ method: m[1].toUpperCase(), subpath: m[2] });
  }
  return out;
}

/**
 * Compose every (method, full path) tuple actually implemented by the BE.
 * full path = mount prefix + router subpath. Routers without a resolved
 * file (require path didn't exist) contribute nothing.
 *
 * @returns {Array<{method:string, path:string, file:string}>}
 */
function extractBeEndpoints(serverFile) {
  if (!fs.existsSync(serverFile)) return [];
  const { mounts } = parseServerFile(serverFile);
  const out = [];
  for (const mnt of mounts) {
    if (!mnt.file) continue;
    const subs = parseRouteFile(mnt.file);
    for (const s of subs) {
      // join, collapsing duplicate '/' at boundary
      const joined = (mnt.prefix.replace(/\/+$/, '') + '/' + s.subpath.replace(/^\/+/, ''))
        .replace(/\/+/g, '/');
      out.push({ method: s.method, path: joined, file: mnt.file });
    }
  }
  return out;
}

// ---------------- diff ----------------

/**
 * Normalize a path for comparison so contract style (`/users/{id}`) and
 * Express style (`/users/:id`) compare equal. Trailing slash stripped.
 */
function normalizePathForDiff(p) {
  let s = String(p);
  s = s.replace(/\{[^}]+\}/g, ':_p');
  s = s.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':_p');
  s = s.replace(/\/+$/, '');
  if (s === '') s = '/';
  return s;
}

function tupleKey(method, p) {
  return `${String(method).toUpperCase()} ${normalizePathForDiff(p)}`;
}

/**
 * Diff contract endpoints vs implemented endpoints.
 *
 * @param {Array<{name?:string, method:string, path:string}>} contractEndpoints
 * @param {Array<{method:string, path:string, file:string}>} codeEndpoints
 * @returns {{pass:boolean, missing:Array, extra:Array}}
 */
function diffEndpoints(contractEndpoints, codeEndpoints) {
  const codeSet = new Set(codeEndpoints.map((e) => tupleKey(e.method, e.path)));
  const contractSet = new Set(contractEndpoints.map((e) => tupleKey(e.method, e.path)));

  const missing = contractEndpoints.filter(
    (e) => !codeSet.has(tupleKey(e.method, e.path))
  );
  const extra = codeEndpoints.filter(
    (e) => !contractSet.has(tupleKey(e.method, e.path))
  );

  // `missing` is the only FAIL signal. `extra` is informational — contract is
  // the source of truth, but FE/PostTest only consume what contract declares,
  // so extra routes can't *break* the pipeline (they're just dead code).
  return { pass: missing.length === 0, missing, extra };
}

// ---------------- fix_instructions composition ----------------

function buildFixInstructions({ missing, extra, contractCount, codeCount }) {
  const lines = [];
  lines.push(
    `[CONTRACT_SYNC] api_contract.json declares ${contractCount} endpoints; ` +
    `BE/src/ implements ${codeCount}.`
  );
  if (missing.length > 0) {
    lines.push('');
    lines.push('Missing endpoints (구현 필요 — contract에 있는데 BE 코드에 없음):');
    for (const m of missing) {
      const tag = m.name ? ` (name: ${m.name})` : '';
      lines.push(`  - ${m.method} ${m.path}${tag}`);
    }
    lines.push('');
    lines.push(
      'Add corresponding Express routes mounted at the contract paths. ' +
      'Use `app.use(<prefix>, <router>)` in server.js and `router.<method>(<subpath>, ...)` ' +
      'in BE/src/routes/<name>_routes.js. Path params: use `:param` (Express style).'
    );
  }
  if (extra.length > 0) {
    lines.push('');
    lines.push('Extra endpoints (contract에 없음 — 제거 또는 contract 보강 필요):');
    for (const e of extra) {
      const f = e.file ? ` [${path.basename(e.file)}]` : '';
      lines.push(`  - ${e.method} ${e.path}${f}`);
    }
  }
  return lines.join('\n');
}

// ---------------- main entry ----------------

/**
 * Run contract↔code sync check.
 *
 * @param {{
 *   contractPath: string,
 *   routerDir?: string,
 *   beServerFile: string,
 * }} params
 * @returns {{
 *   pass: boolean,
 *   skipped?: 'no_server'|'no_contract',
 *   contract_endpoints: Array,
 *   code_endpoints: Array,
 *   missing: Array,
 *   extra: Array,
 *   fix_instructions: string,
 *   error?: string,
 * }}
 */
function checkContractSync({ contractPath, routerDir, beServerFile }) {
  // Skip-no-server: BE Agent hasn't produced server.js yet (round 1 before
  // first BE Agent emit, or BE Agent threw guard error). Treat as pass.
  if (!fs.existsSync(beServerFile)) {
    return {
      pass: true,
      skipped: 'no_server',
      contract_endpoints: [],
      code_endpoints: [],
      missing: [],
      extra: [],
      fix_instructions: '',
    };
  }

  const { endpoints: contractEndpoints, error } = loadContractEndpoints({
    contractPath,
    routerDir,
  });
  if (error) {
    return {
      pass: true,
      skipped: 'no_contract',
      contract_endpoints: [],
      code_endpoints: [],
      missing: [],
      extra: [],
      fix_instructions: '',
      error,
    };
  }

  const codeEndpoints = extractBeEndpoints(beServerFile);
  const { pass, missing, extra } = diffEndpoints(contractEndpoints, codeEndpoints);

  return {
    pass,
    contract_endpoints: contractEndpoints,
    code_endpoints: codeEndpoints,
    missing,
    extra,
    fix_instructions: pass
      ? ''
      : buildFixInstructions({
          missing,
          extra,
          contractCount: contractEndpoints.length,
          codeCount: codeEndpoints.length,
        }),
  };
}

module.exports = {
  checkContractSync,
  // internal — exported for unit tests only
  _internal: {
    loadContractEndpoints,
    parseServerFile,
    parseRouteFile,
    extractBeEndpoints,
    diffEndpoints,
    normalizePathForDiff,
    tupleKey,
    buildFixInstructions,
    resolveRequirePath,
  },
};
