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

// ---------------- endpoint execution ----------------

/**
 * Run a single endpoint test.
 *
 * @param {Object} endpoint - one entry from contract.endpoints[]
 * @param {string} baseUrl  - e.g. 'http://localhost:3001'
 * @returns {Promise<{ pass: boolean, errors: string[], trace: Object }>}
 */
async function runEndpoint(endpoint, baseUrl) {
  const url = `${baseUrl}${endpoint.path}`;
  const method = (endpoint.method || 'GET').toUpperCase();
  const errors = [];
  const trace = { endpoint: endpoint.path, method, url };

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
async function runContract({ baseUrl, contractPath }) {
  const contract = loadContract(contractPath);
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

module.exports = {
  loadContract,
  validate,
  exampleBodyFromSchema,
  runEndpoint,
  runContract,
};
