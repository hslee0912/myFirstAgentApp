'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateFEContract, extractFeFetches, assertFEContract } = require('../lib/fe_contract_guard');

const contractEndpoints = [
  { method: 'POST', path: '/auth/signup' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/game/result' },
  { method: 'GET', path: '/game/best' },
];
const baseUrl = '/api/v1';

test('extractFeFetches: GET fetch literal — method=GET (default)', () => {
  const files = {
    'FE/src/api.js': `const res = await fetch('/api/v1/auth/check?username=' + u);`,
  };
  const fetches = extractFeFetches(files);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].method, 'GET');
  assert.equal(fetches[0].path, '/api/v1/auth/check');
});

test('extractFeFetches: POST fetch with method option', () => {
  const files = {
    'FE/src/api.js': `await fetch('/api/v1/auth/signup', { method: 'POST', body: JSON.stringify(d) });`,
  };
  const fetches = extractFeFetches(files);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].method, 'POST');
  assert.equal(fetches[0].path, '/api/v1/auth/signup');
});

test('extractFeFetches: external URL is skipped (BE host hardcode 별도 규칙)', () => {
  const files = {
    'FE/src/x.js': `fetch('http://localhost:3001/api/v1/auth/signup')`,
  };
  const fetches = extractFeFetches(files);
  assert.equal(fetches.length, 0);
});

test('extractFeFetches: 주석 안 fetch는 무시', () => {
  const files = {
    'FE/src/x.js': `// fetch('/api/v1/auth/check')\nconst x = 1;`,
  };
  const fetches = extractFeFetches(files);
  assert.equal(fetches.length, 0);
});

test('validateFEContract: 모든 fetch URL이 contract에 있음 → PASS', () => {
  const files = {
    'FE/src/api.js': `
      await fetch('/api/v1/auth/signup', { method: 'POST' });
      await fetch('/api/v1/auth/login', { method: 'POST' });
      await fetch('/api/v1/game/best?player_id=1');
    `,
  };
  const r = validateFEContract(files, contractEndpoints, baseUrl);
  assert.equal(r.pass, true);
  assert.equal(r.extra.length, 0);
});

test('validateFEContract: contract에 없는 URL fetch → FAIL', () => {
  const files = {
    'FE/src/membership.jsx': `await fetch('/api/v1/auth/check?username=' + u);`,
  };
  const r = validateFEContract(files, contractEndpoints, baseUrl);
  assert.equal(r.pass, false);
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].path, '/api/v1/auth/check');
  assert.match(r.fix_instructions, /contract에 없는/);
});

test('validateFEContract: contract path를 fetch URL과 직접 매칭 (base_url 없이도)', () => {
  // contract path가 이미 full path인 케이스 — base_url 결합 없이도 매칭되어야
  const files = {
    'FE/src/x.js': `fetch('/auth/signup', { method: 'POST' });`,  // base_url 없이 그대로
  };
  const r = validateFEContract(files, contractEndpoints, baseUrl);
  assert.equal(r.pass, true);  // /auth/signup (base 없이) 또는 /api/v1/auth/signup 둘 다 OK
});

test('validateFEContract: method mismatch도 잡음 (GET vs POST)', () => {
  const files = {
    'FE/src/x.js': `fetch('/api/v1/auth/signup');`,  // method 누락 → GET, 근데 contract는 POST
  };
  const r = validateFEContract(files, contractEndpoints, baseUrl);
  assert.equal(r.pass, false);
  assert.equal(r.extra[0].method, 'GET');
});

test('validateFEContract: fetch 없는 코드 → PASS', () => {
  const files = {
    'FE/src/App.jsx': `function App() { return <div />; }`,
  };
  const r = validateFEContract(files, contractEndpoints, baseUrl);
  assert.equal(r.pass, true);
  assert.equal(r.fetches.length, 0);
});

test('assertFEContract: drift 발견 시 throw with code=FE_CONTRACT_DRIFT', () => {
  const files = {
    'FE/src/x.js': `fetch('/api/v1/auth/check?username=u');`,
  };
  assert.throws(
    () => assertFEContract(files, contractEndpoints, baseUrl),
    (err) => {
      assert.equal(err.code, 'FE_CONTRACT_DRIFT');
      assert.equal(err.extra.length, 1);
      assert.match(err.message, /Contract drift detected/);
      return true;
    }
  );
});

test('assertFEContract: PASS면 throw 안 함', () => {
  const files = {
    'FE/src/x.js': `fetch('/api/v1/auth/signup', { method: 'POST' });`,
  };
  assert.doesNotThrow(() => assertFEContract(files, contractEndpoints, baseUrl));
});

// PoC scope 한계: path param (:id) 정규화는 향후 작업. 본 시스템의 contract는
// 현재 fixed path만 사용. 동적 segment 매칭 도입 시 별도 test로 보강.
