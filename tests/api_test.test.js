/**
 * Unit tests for lib/api_test.js — normalizeContract + exampleBodyFromSchema +
 * the simple JSON Schema validator.
 *
 * Run: npm test  (uses node --test, no extra dependency)
 *
 * Network-touching paths (runEndpoint / runContract) are NOT covered here —
 * they require a live BE, which only Phase 9 end-to-end can provide.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeContract,
  validate,
  exampleBodyFromSchema,
} = require('../lib/api_test');

// ─────────── normalizeContract: canonical format passes through ───────────

test('normalizeContract: canonical { responses } passes through unchanged', () => {
  const input = {
    version: '1.0.0',
    endpoints: [{
      path: '/auth/signup',
      method: 'POST',
      request: { schema: { type: 'object' } },
      responses: {
        '201': { schema: { type: 'object' } },
        '400': { schema: { type: 'object' } },
      },
    }],
  };
  const out = normalizeContract(input);
  assert.equal(out.endpoints[0].path, '/auth/signup');
  assert.deepEqual(Object.keys(out.endpoints[0].responses), ['201', '400']);
});

// ─────────── normalizeContract: base_url prefix ───────────

test('normalizeContract: prefixes base_url onto each endpoint.path', () => {
  const out = normalizeContract({
    base_url: '/api/v1',
    endpoints: [
      { path: '/auth/signup', method: 'POST', responses: { '201': {} } },
      { path: '/auth/login', method: 'POST', responses: { '200': {} } },
    ],
  });
  assert.equal(out.endpoints[0].path, '/api/v1/auth/signup');
  assert.equal(out.endpoints[1].path, '/api/v1/auth/login');
  // base_url is consumed (set to '') so re-normalize is a no-op.
  assert.equal(out.base_url, '');
});

test('normalizeContract: idempotent — running twice does not double-prefix', () => {
  const input = {
    base_url: '/api/v1',
    endpoints: [{ path: '/auth/signup', method: 'POST', responses: { '201': {} } }],
  };
  const once = normalizeContract(input);
  const twice = normalizeContract(once);
  assert.equal(twice.endpoints[0].path, '/api/v1/auth/signup');
});

test('normalizeContract: no base_url leaves path as-is', () => {
  const out = normalizeContract({
    endpoints: [{ path: '/signup', method: 'POST', responses: { '201': {} } }],
  });
  assert.equal(out.endpoints[0].path, '/signup');
});

// ─────────── normalizeContract: legacy response.{success, error_cases} ───────────

test('normalizeContract: legacy response.success → responses[code]', () => {
  const out = normalizeContract({
    endpoints: [{
      path: '/auth/signup',
      method: 'POST',
      response: {
        success: {
          status_code: 201,
          schema: { type: 'object', properties: { success: { type: 'boolean' } } },
        },
      },
    }],
  });
  const ep = out.endpoints[0];
  assert.ok(ep.responses);
  assert.deepEqual(Object.keys(ep.responses), ['201']);
  assert.ok(ep.responses['201'].schema);
  assert.equal(ep.responses['201'].schema.type, 'object');
});

test('normalizeContract: legacy response.error_cases → responses[code]', () => {
  const out = normalizeContract({
    endpoints: [{
      path: '/auth/signup',
      method: 'POST',
      response: {
        success: { status_code: 201, schema: { type: 'object' } },
        error_cases: [
          { status_code: 400, error_code: 'BAD_EMAIL' },
          { status_code: 409, error_code: 'EMAIL_EXISTS', schema: { type: 'object' } },
        ],
      },
    }],
  });
  const ep = out.endpoints[0];
  assert.deepEqual(Object.keys(ep.responses).sort(), ['201', '400', '409']);
  // 400 had no schema → empty object (accepts any body)
  assert.deepEqual(ep.responses['400'], {});
  // 409 had schema → kept
  assert.ok(ep.responses['409'].schema);
});

test('normalizeContract: legacy with base_url combines correctly', () => {
  const out = normalizeContract({
    base_url: '/api/v1',
    endpoints: [{
      path: '/auth/signup',
      method: 'POST',
      response: {
        success: { status_code: 201, schema: { type: 'object' } },
        error_cases: [{ status_code: 400 }],
      },
    }],
  });
  const ep = out.endpoints[0];
  assert.equal(ep.path, '/api/v1/auth/signup');
  assert.deepEqual(Object.keys(ep.responses).sort(), ['201', '400']);
});

// ─────────── normalizeContract: edge cases ───────────

test('normalizeContract: missing endpoints array → empty array result', () => {
  const out = normalizeContract({});
  assert.deepEqual(out.endpoints, []);
});

test('normalizeContract: null/undefined input returns as-is', () => {
  assert.equal(normalizeContract(null), null);
  assert.equal(normalizeContract(undefined), undefined);
});

test('normalizeContract: endpoint with neither response nor responses → empty responses', () => {
  const out = normalizeContract({
    endpoints: [{ path: '/health', method: 'GET' }],
  });
  assert.deepEqual(out.endpoints[0].responses, {});
});

// ─────────── exampleBodyFromSchema ───────────

test('exampleBodyFromSchema: builds body from properties.<field>.example', () => {
  const body = exampleBodyFromSchema({
    type: 'object',
    properties: {
      email: { type: 'string', example: 'a@b.c' },
      password: { type: 'string', example: 'hunter22' },
    },
  });
  assert.deepEqual(body, { email: 'a@b.c', password: 'hunter22' });
});

test('exampleBodyFromSchema: nested object recurses', () => {
  const body = exampleBodyFromSchema({
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: {
          email: { type: 'string', example: 'a@b.c' },
        },
      },
    },
  });
  assert.deepEqual(body, { user: { email: 'a@b.c' } });
});

test('exampleBodyFromSchema: non-object schema → null', () => {
  assert.equal(exampleBodyFromSchema({ type: 'string' }), null);
  assert.equal(exampleBodyFromSchema(null), null);
});

// ─────────── validate: smoke checks (the core is exercised in api_test E2E) ───────────

test('validate: type mismatch reports an error', () => {
  const errs = validate(42, { type: 'string' });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /expected type=string/);
});

test('validate: required field missing reports an error', () => {
  const errs = validate({}, { type: 'object', required: ['x'] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /missing required field "x"/);
});

test('validate: const mismatch reports an error', () => {
  const errs = validate(false, { type: 'boolean', const: true });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /expected const=true/);
});

test('validate: email format loose check', () => {
  assert.deepEqual(validate('a@b.c', { type: 'string', format: 'email' }), []);
  const bad = validate('not-an-email', { type: 'string', format: 'email' });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /expected email format/);
});

// ─────────── normalizeContract: split layout (routerDir option) ───────────

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Create a temp router/ directory with the given files inside it. */
function mkTempRouter(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  return dir;
}

test('normalizeContract: index entry expands via routerDir', () => {
  const routerDir = mkTempRouter({
    'auth_signup.json': {
      path: '/auth/signup',
      method: 'POST',
      request: { schema: { type: 'object' } },
      responses: { '201': { schema: { type: 'object' } } },
    },
  });
  const input = {
    version: '1.0.0',
    endpoints: [
      { name: 'auth_signup', path: '/auth/signup', method: 'POST', description: '...' },
    ],
  };
  const out = normalizeContract(input, { routerDir });
  const ep = out.endpoints[0];
  assert.equal(ep.path, '/auth/signup');
  assert.equal(ep.method, 'POST');
  assert.ok(ep.request);
  assert.deepEqual(Object.keys(ep.responses), ['201']);
});

test('normalizeContract: index + base_url combine through expansion', () => {
  const routerDir = mkTempRouter({
    'auth_signup.json': {
      path: '/auth/signup',
      method: 'POST',
      request: { schema: { type: 'object' } },
      responses: { '201': { schema: { type: 'object' } } },
    },
  });
  const out = normalizeContract(
    {
      version: '1.0.0',
      base_url: '/api/v1',
      endpoints: [{ name: 'auth_signup', path: '/auth/signup', method: 'POST' }],
    },
    { routerDir },
  );
  assert.equal(out.endpoints[0].path, '/api/v1/auth/signup');
});

test('normalizeContract: index entry maps legacy responses dialect from detail file', () => {
  const routerDir = mkTempRouter({
    'auth_signup.json': {
      path: '/auth/signup',
      method: 'POST',
      response: {
        success: { status_code: 201, schema: { type: 'object' } },
        error_cases: [{ status_code: 400 }],
      },
    },
  });
  const out = normalizeContract(
    {
      endpoints: [{ name: 'auth_signup', path: '/auth/signup', method: 'POST' }],
    },
    { routerDir },
  );
  const ep = out.endpoints[0];
  assert.deepEqual(Object.keys(ep.responses).sort(), ['201', '400']);
  assert.ok(ep.responses['201'].schema);
  assert.deepEqual(ep.responses['400'], {});
});

test('normalizeContract: missing router file throws a clear error', () => {
  const routerDir = mkTempRouter({});
  assert.throws(
    () => normalizeContract(
      { endpoints: [{ name: 'auth_signup', path: '/auth/signup', method: 'POST' }] },
      { routerDir },
    ),
    /endpoint 'auth_signup' declared in api_contract.json but/,
  );
});

test('normalizeContract: routerDir omitted leaves index entries as-is (legacy path)', () => {
  const out = normalizeContract({
    endpoints: [{ name: 'auth_signup', path: '/auth/signup', method: 'POST' }],
  });
  const ep = out.endpoints[0];
  assert.equal(ep.name, 'auth_signup');
  assert.equal(ep.path, '/auth/signup');
  // No detail expansion happened — responses defaults to empty object.
  assert.deepEqual(ep.responses, {});
});

test('normalizeContract: routerDir set but endpoint already has request/responses → no detail read', () => {
  // routerDir points at empty dir; if expansion were triggered we'd throw.
  const routerDir = mkTempRouter({});
  const out = normalizeContract(
    {
      endpoints: [
        {
          name: 'auth_signup',
          path: '/auth/signup',
          method: 'POST',
          request: { schema: { type: 'object' } },
          responses: { '201': { schema: { type: 'object' } } },
        },
      ],
    },
    { routerDir },
  );
  assert.equal(out.endpoints[0].path, '/auth/signup');
});
