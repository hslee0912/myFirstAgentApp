/**
 * Phase 9 helper — deterministic API contract test runner (no LLM).
 *
 * Reads `shared/api_contract.json`, calls each declared endpoint with the
 * example request body, and validates the response against the schema for
 * the returned status code.
 *
 * Decision provenance (docs/DECISIONS.md, 2026-05-08):
 *   D3, D4 → deterministic schema-shape verification
 *   D33=A  → Node 18+ built-in `fetch` (no extra dep)
 *   D34=B  → simple in-house JSON Schema validator (no `ajv` dep)
 *   D35=A  → request body built from `properties.<field>.example`
 *   D36=A  → sequential endpoint execution (preserves natural ordering)
 *
 * Pass criterion (D4):
 *   - Response status code MUST be one of `endpoint.responses` keys.
 *   - Response body MUST validate against the schema for that status.
 *   - "200 mandatory" is NOT the rule — a 401 declared in the contract is fine
 *     so long as the body matches its declared schema.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONTRACT_PATH = path.join(ROOT, 'shared', 'api_contract.json');

// ---------------- contract loader ----------------

function loadContract(p = DEFAULT_CONTRACT_PATH) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

/**
 * Normalize an api_contract into the shape runEndpoint expects.
 *
 * Three input dialects are supported (one canonical, two legacy):
 *
 *  (1) Canonical split — `endpoints[i] = { name, path, method, description }`,
 *      with the full detail living in `shared/router/<name>.json`. Pass
 *      `routerDir` so this function can read and inline each detail.
 *
 *  (2) Legacy inline — `endpoints[i]` already carries `request` + `responses`
 *      (or `response.{success, error_cases}`); no router file read needed.
 *
 *  (3) Legacy response shape — even when inline, the old
 *      `response: { success: {status_code, schema}, error_cases: [...] }`
 *      shape is mapped onto the canonical `responses: { '<code>': {schema?} }`.
 *
 * Idempotent: re-normalizing a normalized contract is a no-op (base_url is
 * consumed at the contract level; endpoint.path keeps the prefixed value).
 *
 * @param {Object} contract
 * @param {Object} [opts]
 * @param {string} [opts.routerDir] - directory holding `<name>.json` detail
 *   files. When omitted, index-style endpoints stay as-is.
 * @returns {Object} a new contract object with fully-expanded, normalized endpoints
 */
function normalizeContract(contract, { routerDir } = {}) {
  if (!contract || typeof contract !== 'object') return contract;
  const baseUrl = typeof contract.base_url === 'string' ? contract.base_url : '';
  const endpoints = Array.isArray(contract.endpoints) ? contract.endpoints : [];

  const normalized = endpoints.map((rawEp) => {
    // Step 1: if this is an index entry, expand it by reading the detail file.
    let ep = rawEp;
    const isIndexEntry =
      ep && ep.name && !ep.request && !ep.responses && !ep.response;
    if (isIndexEntry && routerDir) {
      const detailPath = path.join(routerDir, `${ep.name}.json`);
      if (!fs.existsSync(detailPath)) {
        throw new Error(
          `[api_test] endpoint '${ep.name}' declared in api_contract.json but ` +
          `${detailPath} not found`
        );
      }
      const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
      // Index entry fields (path, method, description) win on conflict only
      // when detail leaves them undefined; otherwise detail is the source.
      ep = { ...ep, ...detail };
    }

    // Step 2: base_url prefix (idempotent).
    const rawPath = ep.path || '';
    const epPath =
      baseUrl && !rawPath.startsWith(baseUrl) ? `${baseUrl}${rawPath}` : rawPath;

    // Step 3: responses normalization (canonical or legacy response shape).
    let responses = ep.responses;
    if (!responses || typeof responses !== 'object') {
      responses = {};
      const legacy = ep.response;
      if (legacy && typeof legacy === 'object') {
        if (legacy.success && legacy.success.status_code != null) {
          const k = String(legacy.success.status_code);
          responses[k] = legacy.success.schema ? { schema: legacy.success.schema } : {};
        }
        if (Array.isArray(legacy.error_cases)) {
          for (const ec of legacy.error_cases) {
            if (ec && ec.status_code != null) {
              const k = String(ec.status_code);
              responses[k] = ec.schema ? { schema: ec.schema } : {};
            }
          }
        }
      }
    }

    return { ...ep, path: epPath, responses };
  });

  // base_url is consumed; clear it on the returned object so re-normalization
  // is a no-op even if the same instance is re-fed.
  return { ...contract, base_url: '', endpoints: normalized };
}

// ---------------- D34=B: simple JSON Schema validator ----------------

/**
 * Validate `value` against `schema`, returning an array of error strings.
 * Empty array = valid.
 *
 * Supported subset (matches what `shared/api_contract.json` actually uses):
 *   - type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
 *   - required: string[]
 *   - properties: { <key>: <subschema> }
 *   - const: any (exact value match)
 *   - format: 'email'  (loose regex, intentionally permissive)
 *   - minLength / maxLength (string length)
 *
 * Anything outside this subset is silently ignored — the validator is
 * intentionally minimal so it stays understandable as a teaching artifact.
 */
function validate(value, schema, dotPath = '') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  // type check (with integer/number nuance)
  if (schema.type) {
    const expected = schema.type;
    let actual;
    if (Array.isArray(value)) actual = 'array';
    else if (value === null) actual = 'null';
    else if (typeof value === 'number') actual = Number.isInteger(value) ? 'integer' : 'number';
    else actual = typeof value;

    // integer is a subtype of number
    let typeOk = expected === actual;
    if (!typeOk && expected === 'number' && actual === 'integer') typeOk = true;

    if (!typeOk) {
      errors.push(`${dotPath || '<root>'}: expected type=${expected}, got ${actual}`);
      return errors; // stop deeper checks if type fails
    }
  }

  // const (exact match)
  if ('const' in schema) {
    if (value !== schema.const) {
      errors.push(
        `${dotPath || '<root>'}: expected const=${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`
      );
    }
  }

  // string-specific
  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.format === 'email') {
      // Loose check — full RFC 5322 is overkill for a PoC.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        errors.push(`${dotPath || '<root>'}: expected email format, got "${value}"`);
      }
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${dotPath || '<root>'}: minLength=${schema.minLength}, got length=${value.length}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${dotPath || '<root>'}: maxLength=${schema.maxLength}, got length=${value.length}`);
    }
  }

  // object: required fields + properties recursion
  if (
    schema.type === 'object' &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push(`${dotPath || '<root>'}: missing required field "${key}"`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) {
          const childPath = dotPath ? `${dotPath}.${key}` : key;
          errors.push(...validate(value[key], sub, childPath));
        }
      }
    }
  }

  return errors;
}

// ---------------- D35=A: request body from examples ----------------

/**
 * Walk an object schema's properties and assemble a request body using each
 * property's `example` value. Returns `null` if the schema has no usable
 * properties (e.g. GET endpoint without a request body).
 */
function exampleBodyFromSchema(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return null;
  const out = {};
  for (const [key, sub] of Object.entries(schema.properties)) {
    if ('example' in sub) {
      out[key] = sub.example;
    } else if (sub && sub.type === 'object' && sub.properties) {
      const nested = exampleBodyFromSchema(sub);
      if (nested !== null) out[key] = nested;
    }
  }
  return out;
}

// ---------------- D49 (2026-05-14): path param substitution ----------------

/**
 * URL의 path param placeholder를 *example 값*으로 치환.
 *
 * 사용자 보고 사고 (big-cycle 5): PostTest가 `/api/result/best/:player_id`를
 * 그대로 fetch → BE가 ":player_id" 문자열을 정수 parsing 시도 → 400. LLM이
 * emit한 contract·BE 코드는 *정상*인데 시스템 도구가 표준을 못 따라서 fail.
 *
 * 치환 패턴:
 *   - Express style:  `:player_id`     → "1"
 *   - OpenAPI style:  `{player_id}`    → "1"
 *
 * 값 우선순위:
 *   ① endpoint.path_params[name].example      — contract 명시
 *   ② endpoint.request.schema.properties[name].example — body schema의 example
 *   ③ fallback: 1 (정수형 ID 가정. 대부분의 RESTful 패턴에 적합)
 *
 * @param {string} pathTemplate
 * @param {Object} endpoint
 * @returns {string}
 */
function substitutePathParams(pathTemplate, endpoint) {
  if (typeof pathTemplate !== 'string' || pathTemplate.length === 0) return pathTemplate;

  const explicit = (endpoint && endpoint.path_params) || {};
  const bodyProps =
    (endpoint && endpoint.request && endpoint.request.schema && endpoint.request.schema.properties) || {};

  function resolveValue(name) {
    if (explicit[name] && explicit[name].example != null) return String(explicit[name].example);
    if (bodyProps[name] && bodyProps[name].example != null) return String(bodyProps[name].example);
    return '1';   // RESTful ID convention fallback
  }

  // :paramName (Express) — 이름은 영문자/숫자/_ 만
  let out = pathTemplate.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => encodeURIComponent(resolveValue(n)));
  // {paramName} (OpenAPI)
  out = out.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => encodeURIComponent(resolveValue(n)));
  return out;
}

// ---------------- endpoint execution ----------------

/**
 * Run a single endpoint test.
 *
 * @param {Object} endpoint - one entry from contract.endpoints[]
 * @param {string} baseUrl  - e.g. 'http://${PUBLIC_HOST}:3001' (caller composes;
 *                            PUBLIC_HOST is 'localhost' on dev, EC2 DNS on remote)
 * @returns {Promise<{ pass: boolean, errors: string[], trace: Object }>}
 */
async function runEndpoint(endpoint, baseUrl) {
  // D49: path param 치환 (Express `:id` / OpenAPI `{id}` 둘 다)
  const resolvedPath = substitutePathParams(endpoint.path, endpoint);
  const url = `${baseUrl}${resolvedPath}`;
  const method = (endpoint.method || 'GET').toUpperCase();
  const errors = [];
  const trace = { endpoint: endpoint.path, method, url, resolved_path: resolvedPath };

  // Build request body from example (D35=A)
  const requestSchema = endpoint.request && endpoint.request.schema;
  const body = requestSchema ? exampleBodyFromSchema(requestSchema) : null;
  trace.request_body = body;

  // Send request
  let res;
  let responseBody;
  try {
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== null && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(body);
    }
    res = await fetch(url, init);
    const text = await res.text();
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { _raw: text };
    }
  } catch (e) {
    errors.push(`fetch failed: ${e.message}`);
    return { pass: false, errors, trace };
  }

  trace.status = res.status;
  trace.response_body = responseBody;

  // Pass criterion: status must be a declared response key, and body must
  // match that response's schema.
  const responses = endpoint.responses || {};
  const expected = responses[String(res.status)];
  if (!expected) {
    errors.push(
      `unexpected status ${res.status} (declared statuses: ${Object.keys(responses).join(', ') || 'none'})`
    );
    return { pass: false, errors, trace };
  }
  if (expected.schema) {
    const schemaErrors = validate(responseBody, expected.schema, 'response');
    errors.push(...schemaErrors);
  }

  return { pass: errors.length === 0, errors, trace };
}

/**
 * Run all endpoints in the contract sequentially (D36=A).
 *
 * @param {{ baseUrl: string, contractPath?: string }} params
 * @returns {Promise<{ pass: boolean, total: number, passed: number, results: Array, duration_ms: number }>}
 */
async function runContract({ baseUrl, contractPath, routerDir }) {
  const resolvedContractPath = contractPath || DEFAULT_CONTRACT_PATH;
  const resolvedRouterDir =
    routerDir || path.join(path.dirname(resolvedContractPath), 'router');
  const contract = normalizeContract(
    loadContract(resolvedContractPath),
    { routerDir: resolvedRouterDir },
  );
  const endpoints = Array.isArray(contract.endpoints) ? contract.endpoints : [];

  const startedAt = Date.now();
  const results = [];
  let passed = 0;

  for (const endpoint of endpoints) {
    const r = await runEndpoint(endpoint, baseUrl);
    if (r.pass) passed += 1;
    results.push({
      endpoint: endpoint.path,
      method: endpoint.method,
      pass: r.pass,
      errors: r.errors,
      trace: r.trace,
    });
  }

  return {
    pass: endpoints.length > 0 && passed === endpoints.length,
    total: endpoints.length,
    passed,
    results,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Pretty checklist of every (method, fullpath) endpoint in a (normalized) contract.
 * Used by BE/FE Agent prompts to make endpoint requirements *explicit* — LLM이
 * api_contract JSON을 *해석*해서 모든 endpoint를 implementing해야 한다는 사실을
 * 추론하지 않아도 되게.
 *
 * Returns '' when the contract is missing or has no endpoints — callers should
 * fall through to "(없음)" or similar.
 *
 * Why this matters (D39, 2026-05-14):
 *   - ContractSync(Phase 2.7)가 retry로 누락을 잡지만 *retry 안 들어가는 게
 *     정상 경로*. prompt에 explicit list가 있으면 LLM이 첫 시도부터 모두 구현.
 *   - JSON 블록은 LLM이 *구조*는 파악해도 *전부를 빠짐없이 구현해야 한다*는
 *     강제 신호로 부족. 단순 list가 더 명시적.
 *
 * @param {Object|null} contract  Normalized contract (or raw — paths가 base_url
 *                                포함이면 그대로 표시).
 * @returns {string}              "- POST /api/v1/auth/signup\n- ..." 형태,
 *                                또는 endpoint 없으면 ''.
 */
function endpointChecklist(contract) {
  if (!contract || typeof contract !== 'object') return '';
  const endpoints = Array.isArray(contract.endpoints) ? contract.endpoints : [];
  const baseUrl = typeof contract.base_url === 'string' ? contract.base_url : '';
  const lines = [];
  for (const ep of endpoints) {
    if (!ep || !ep.method || !ep.path) continue;
    const method = String(ep.method).toUpperCase().padEnd(6);
    // base_url 이미 contained면 중복 X. normalizeContract 거치면 base_url=''.
    const fullPath = baseUrl && !String(ep.path).startsWith(baseUrl)
      ? `${baseUrl}${ep.path}`
      : ep.path;
    lines.push(`- ${method} ${fullPath}`);
  }
  return lines.join('\n');
}

module.exports = {
  loadContract,
  normalizeContract,
  validate,
  exampleBodyFromSchema,
  runEndpoint,
  runContract,
  endpointChecklist,
  substitutePathParams,   // D49
};
