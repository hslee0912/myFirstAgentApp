/**
 * Unit tests for lib/contract_sync.js (D36, 2026-05-14, Phase 2.7).
 *
 * 임시 디렉터리에 fake BE 트리 + api_contract.json을 깐 뒤 정규식 파싱 + diff
 * 로직만 검증. orchestrator 통합/DB는 별도 e2e에서.
 *
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkContractSync,
  _internal,
} = require('../lib/contract_sync');

// ─────────── tmp dir helpers ───────────

function mkTmp(prefix = 'csync-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// ─────────── normalizePathForDiff ───────────

test('normalizePathForDiff — OpenAPI brace param과 Express colon param이 동등', () => {
  const { normalizePathForDiff } = _internal;
  assert.equal(
    normalizePathForDiff('/users/{id}'),
    normalizePathForDiff('/users/:id')
  );
  assert.equal(
    normalizePathForDiff('/a/{x}/b/:y'),
    normalizePathForDiff('/a/:p/b/:q')
  );
});

test('normalizePathForDiff — trailing slash 무시, 빈 path는 "/"', () => {
  const { normalizePathForDiff } = _internal;
  assert.equal(normalizePathForDiff('/users/'), '/users');
  assert.equal(normalizePathForDiff(''), '/');
  assert.equal(normalizePathForDiff('/'), '/');
});

// ─────────── parseServerFile ───────────

test('parseServerFile — app.use prefix + require var 매핑', () => {
  const dir = mkTmp();
  try {
    const server = path.join(dir, 'server.js');
    writeFile(path.join(dir, 'routes', 'auth_routes.js'), 'module.exports = {};\n');
    writeFile(path.join(dir, 'routes', 'result_routes.js'), 'module.exports = {};\n');
    writeFile(server, `
      'use strict';
      const express = require('express');
      const authRoutes = require('./routes/auth_routes');
      const resultRoutes = require('./routes/result_routes');
      const app = express();
      app.use('/api/v1/auth', authRoutes);
      app.use('/api/v1', resultRoutes);
    `);
    const { mounts } = _internal.parseServerFile(server);
    assert.equal(mounts.length, 2);
    assert.equal(mounts[0].prefix, '/api/v1/auth');
    assert.equal(mounts[0].varName, 'authRoutes');
    assert.ok(mounts[0].file.endsWith('auth_routes.js'));
    assert.equal(mounts[1].prefix, '/api/v1');
    assert.ok(mounts[1].file.endsWith('result_routes.js'));
  } finally { cleanup(dir); }
});

test('parseServerFile — 주석 안의 app.use는 무시', () => {
  const dir = mkTmp();
  try {
    const server = path.join(dir, 'server.js');
    writeFile(path.join(dir, 'routes', 'real.js'), 'module.exports = {};\n');
    writeFile(server, `
      const real = require('./routes/real');
      // app.use('/fake', fakeRouter);
      /* app.use('/also-fake', another); */
      app.use('/real', real);
    `);
    const { mounts } = _internal.parseServerFile(server);
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].prefix, '/real');
  } finally { cleanup(dir); }
});

// ─────────── parseRouteFile ───────────

test('parseRouteFile — router.get/post/put 등 다 추출', () => {
  const dir = mkTmp();
  try {
    const route = path.join(dir, 'routes', 'r.js');
    writeFile(route, `
      const router = require('express').Router();
      router.get('/list', (req, res) => res.json([]));
      router.post('/create', (req, res) => res.status(201).send());
      router.put('/items/:id', (req, res) => res.send());
      router.delete('/items/:id', (req, res) => res.send());
      module.exports = router;
    `);
    const subs = _internal.parseRouteFile(route);
    assert.equal(subs.length, 4);
    assert.deepEqual(subs.map((s) => s.method), ['GET', 'POST', 'PUT', 'DELETE']);
    assert.deepEqual(
      subs.map((s) => s.subpath),
      ['/list', '/create', '/items/:id', '/items/:id']
    );
  } finally { cleanup(dir); }
});

test('parseRouteFile — 주석 안의 router.get 무시', () => {
  const dir = mkTmp();
  try {
    const route = path.join(dir, 'routes', 'r.js');
    writeFile(route, `
      // router.get('/fake1', ...)
      /* router.post('/fake2', ...) */
      router.get('/real', (req, res) => res.send());
    `);
    const subs = _internal.parseRouteFile(route);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].subpath, '/real');
  } finally { cleanup(dir); }
});

// ─────────── extractBeEndpoints (end-to-end of static side) ───────────

test('extractBeEndpoints — prefix + subpath 결합 + double-slash 제거', () => {
  const dir = mkTmp();
  try {
    const server = path.join(dir, 'server.js');
    writeFile(path.join(dir, 'routes', 'auth_routes.js'), `
      const router = require('express').Router();
      router.post('/signup', (req, res) => {});
      router.post('/login', (req, res) => {});
      module.exports = router;
    `);
    writeFile(path.join(dir, 'routes', 'result_routes.js'), `
      const router = require('express').Router();
      router.post('/result', (req, res) => {});
      router.get('/best', (req, res) => {});
      module.exports = router;
    `);
    writeFile(server, `
      const authRoutes = require('./routes/auth_routes');
      const resultRoutes = require('./routes/result_routes');
      app.use('/api/v1/auth/', authRoutes);
      app.use('/api/v1', resultRoutes);
    `);
    const eps = _internal.extractBeEndpoints(server);
    const tuples = eps.map((e) => `${e.method} ${e.path}`).sort();
    assert.deepEqual(tuples, [
      'GET /api/v1/best',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/signup',
      'POST /api/v1/result',
    ]);
  } finally { cleanup(dir); }
});

test('extractBeEndpoints — server.js 없으면 빈 배열', () => {
  const dir = mkTmp();
  try {
    const eps = _internal.extractBeEndpoints(path.join(dir, 'nope.js'));
    assert.deepEqual(eps, []);
  } finally { cleanup(dir); }
});

// ─────────── diffEndpoints ───────────

test('diffEndpoints — 정확히 매칭되면 pass=true, missing/extra 비어있음', () => {
  const { diffEndpoints } = _internal;
  const contract = [
    { method: 'POST', path: '/api/v1/auth/signup' },
    { method: 'GET', path: '/api/v1/best' },
  ];
  const code = [
    { method: 'POST', path: '/api/v1/auth/signup', file: 'a.js' },
    { method: 'GET', path: '/api/v1/best', file: 'b.js' },
  ];
  const r = diffEndpoints(contract, code);
  assert.equal(r.pass, true);
  assert.equal(r.missing.length, 0);
  assert.equal(r.extra.length, 0);
});

test('diffEndpoints — contract에 있는데 code에 없으면 missing', () => {
  const { diffEndpoints } = _internal;
  const contract = [
    { method: 'POST', path: '/api/v1/auth/signup', name: 'auth_signup' },
    { method: 'GET', path: '/api/v1/best' },
  ];
  const code = [
    { method: 'POST', path: '/api/v1/auth/signup', file: 'a.js' },
  ];
  const r = diffEndpoints(contract, code);
  assert.equal(r.pass, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].path, '/api/v1/best');
});

test('diffEndpoints — code에만 있으면 extra (pass에는 영향 없음)', () => {
  const { diffEndpoints } = _internal;
  const contract = [{ method: 'POST', path: '/a' }];
  const code = [
    { method: 'POST', path: '/a', file: 'x.js' },
    { method: 'DELETE', path: '/secret', file: 'x.js' },
  ];
  const r = diffEndpoints(contract, code);
  assert.equal(r.pass, true);   // missing 없음 → pass
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].path, '/secret');
});

test('diffEndpoints — OpenAPI {id} vs Express :id 동등 처리', () => {
  const { diffEndpoints } = _internal;
  const contract = [{ method: 'GET', path: '/users/{id}' }];
  const code = [{ method: 'GET', path: '/users/:id', file: 'x.js' }];
  const r = diffEndpoints(contract, code);
  assert.equal(r.pass, true);
  assert.equal(r.missing.length, 0);
});

test('diffEndpoints — method 다르면 mismatch', () => {
  const { diffEndpoints } = _internal;
  const contract = [{ method: 'POST', path: '/x' }];
  const code = [{ method: 'GET', path: '/x', file: 'a.js' }];
  const r = diffEndpoints(contract, code);
  assert.equal(r.pass, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].method, 'POST');
});

// ─────────── checkContractSync (top-level) ───────────

test('checkContractSync — BE server.js 없으면 skipped=no_server, pass=true', () => {
  const dir = mkTmp();
  try {
    const contractPath = path.join(dir, 'shared', 'api_contract.json');
    writeFile(contractPath, JSON.stringify({
      version: '1.0',
      base_url: '/api/v1',
      endpoints: [{ name: 'x', path: '/x', method: 'GET' }],
    }));
    const r = checkContractSync({
      contractPath,
      routerDir: path.join(dir, 'shared', 'router'),
      beServerFile: path.join(dir, 'BE', 'src', 'server.js'),
    });
    assert.equal(r.pass, true);
    assert.equal(r.skipped, 'no_server');
  } finally { cleanup(dir); }
});

test('checkContractSync — api_contract 없으면 skipped=no_contract, pass=true', () => {
  const dir = mkTmp();
  try {
    const server = path.join(dir, 'BE', 'src', 'server.js');
    writeFile(server, 'app.use("/", x);');
    const r = checkContractSync({
      contractPath: path.join(dir, 'shared', 'api_contract.json'),
      routerDir: path.join(dir, 'shared', 'router'),
      beServerFile: server,
    });
    assert.equal(r.pass, true);
    assert.equal(r.skipped, 'no_contract');
    assert.ok(r.error);
  } finally { cleanup(dir); }
});

test('checkContractSync — contract 4개 endpoint와 BE 코드가 정확히 일치 → PASS', () => {
  const dir = mkTmp();
  try {
    const contractPath = path.join(dir, 'shared', 'api_contract.json');
    // inline `responses: {}`로 index-entry 분기를 피한다 (router/<name>.json 생략 가능).
    writeFile(contractPath, JSON.stringify({
      version: '1.0',
      base_url: '/api/v1',
      endpoints: [
        { name: 'auth_signup', path: '/auth/signup', method: 'POST', responses: {} },
        { name: 'auth_login', path: '/auth/login', method: 'POST', responses: {} },
        { name: 'result_save', path: '/result', method: 'POST', responses: {} },
        { name: 'result_best', path: '/best', method: 'GET', responses: {} },
      ],
    }));
    const server = path.join(dir, 'BE', 'src', 'server.js');
    writeFile(path.join(dir, 'BE', 'src', 'routes', 'auth_routes.js'), `
      const router = require('express').Router();
      router.post('/signup', (req, res) => {});
      router.post('/login', (req, res) => {});
      module.exports = router;
    `);
    writeFile(path.join(dir, 'BE', 'src', 'routes', 'result_routes.js'), `
      const router = require('express').Router();
      router.post('/result', (req, res) => {});
      router.get('/best', (req, res) => {});
      module.exports = router;
    `);
    writeFile(server, `
      const authRoutes = require('./routes/auth_routes');
      const resultRoutes = require('./routes/result_routes');
      app.use('/api/v1/auth', authRoutes);
      app.use('/api/v1', resultRoutes);
    `);

    const r = checkContractSync({
      contractPath,
      routerDir: path.join(dir, 'shared', 'router'),
      beServerFile: server,
    });
    assert.equal(r.pass, true);
    assert.equal(r.contract_endpoints.length, 4);
    assert.equal(r.code_endpoints.length, 4);
    assert.equal(r.missing.length, 0);
  } finally { cleanup(dir); }
});

test('checkContractSync — BE가 endpoint 1개 누락 → FAIL + fix_instructions', () => {
  const dir = mkTmp();
  try {
    const contractPath = path.join(dir, 'shared', 'api_contract.json');
    writeFile(contractPath, JSON.stringify({
      version: '1.0',
      base_url: '/api/v1',
      endpoints: [
        { name: 'auth_signup', path: '/auth/signup', method: 'POST', responses: {} },
        { name: 'auth_login', path: '/auth/login', method: 'POST', responses: {} },
      ],
    }));
    const server = path.join(dir, 'BE', 'src', 'server.js');
    writeFile(path.join(dir, 'BE', 'src', 'routes', 'auth_routes.js'), `
      const router = require('express').Router();
      router.post('/signup', (req, res) => {});
      // /login 누락!
      module.exports = router;
    `);
    writeFile(server, `
      const authRoutes = require('./routes/auth_routes');
      app.use('/api/v1/auth', authRoutes);
    `);

    const r = checkContractSync({
      contractPath,
      routerDir: path.join(dir, 'shared', 'router'),
      beServerFile: server,
    });
    assert.equal(r.pass, false);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].name, 'auth_login');
    assert.equal(r.missing[0].path, '/api/v1/auth/login');
    assert.match(r.fix_instructions, /\[CONTRACT_SYNC\]/);
    assert.match(r.fix_instructions, /Missing endpoints/);
    assert.match(r.fix_instructions, /POST \/api\/v1\/auth\/login/);
  } finally { cleanup(dir); }
});

test('checkContractSync — mount 자체가 빠지면 모든 endpoint missing', () => {
  const dir = mkTmp();
  try {
    const contractPath = path.join(dir, 'shared', 'api_contract.json');
    writeFile(contractPath, JSON.stringify({
      version: '1.0',
      base_url: '/api/v1',
      endpoints: [
        { name: 'a', path: '/a', method: 'GET', responses: {} },
        { name: 'b', path: '/b', method: 'POST', responses: {} },
      ],
    }));
    const server = path.join(dir, 'BE', 'src', 'server.js');
    writeFile(path.join(dir, 'BE', 'src', 'routes', 'r.js'), `
      const router = require('express').Router();
      router.get('/a', (req, res) => {});
      router.post('/b', (req, res) => {});
      module.exports = router;
    `);
    // routes 파일은 있지만 server.js에 app.use 없음
    writeFile(server, `
      const r = require('./routes/r');
      // forgot: app.use('/api/v1', r);
    `);

    const result = checkContractSync({
      contractPath,
      routerDir: path.join(dir, 'shared', 'router'),
      beServerFile: server,
    });
    assert.equal(result.pass, false);
    assert.equal(result.missing.length, 2);
    assert.equal(result.code_endpoints.length, 0);
  } finally { cleanup(dir); }
});

test('checkContractSync — extra endpoint는 pass에 영향 없고 fix_instructions에 표시', () => {
  const dir = mkTmp();
  try {
    const contractPath = path.join(dir, 'shared', 'api_contract.json');
    writeFile(contractPath, JSON.stringify({
      version: '1.0',
      base_url: '',
      endpoints: [
        { name: 'a', path: '/a', method: 'GET', responses: {} },
      ],
    }));
    const server = path.join(dir, 'BE', 'src', 'server.js');
    writeFile(path.join(dir, 'BE', 'src', 'routes', 'r.js'), `
      const router = require('express').Router();
      router.get('/a', (req, res) => {});
      router.delete('/secret', (req, res) => {});
      module.exports = router;
    `);
    writeFile(server, `
      const r = require('./routes/r');
      app.use('/', r);
    `);

    const result = checkContractSync({
      contractPath,
      routerDir: path.join(dir, 'shared', 'router'),
      beServerFile: server,
    });
    assert.equal(result.pass, true);    // missing 없음 → pass
    assert.equal(result.extra.length, 1);
    assert.equal(result.extra[0].path, '/secret');
  } finally { cleanup(dir); }
});

// ─────────── buildFixInstructions ───────────

test('buildFixInstructions — missing이 있으면 [CONTRACT_SYNC] tag + 항목 표시', () => {
  const { buildFixInstructions } = _internal;
  const out = buildFixInstructions({
    missing: [
      { name: 'foo', method: 'POST', path: '/foo' },
      { method: 'GET', path: '/bar' },
    ],
    extra: [],
    contractCount: 2,
    codeCount: 0,
  });
  assert.match(out, /\[CONTRACT_SYNC\]/);
  assert.match(out, /declares 2 endpoints/);
  assert.match(out, /implements 0/);
  assert.match(out, /POST \/foo \(name: foo\)/);
  assert.match(out, /GET \/bar/);
});

test('buildFixInstructions — extra만 있으면 Extra section 있고 Missing section 없음', () => {
  const { buildFixInstructions } = _internal;
  const out = buildFixInstructions({
    missing: [],
    extra: [{ method: 'DELETE', path: '/x', file: '/abs/path/x.js' }],
    contractCount: 0,
    codeCount: 1,
  });
  assert.doesNotMatch(out, /Missing endpoints/);
  assert.match(out, /Extra endpoints/);
  assert.match(out, /DELETE \/x \[x\.js\]/);
});
