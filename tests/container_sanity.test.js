/**
 * Unit tests for lib/container_sanity.js (D45, 2026-05-14).
 *
 * 4 antipattern 각각 + 정상 case + 통합 (여러 위반 동시) 검증.
 * tmp 디렉터리에 fake BE/src/server.js 작성 후 checkBeServerSanity 호출.
 *
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkBeServerSanity } = require('../lib/container_sanity');

// ─────────── helpers ───────────

function mkBeRoot(serverJsContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csanity-'));
  const srvDir = path.join(dir, 'src');
  fs.mkdirSync(srvDir, { recursive: true });
  fs.writeFileSync(path.join(srvDir, 'server.js'), serverJsContent, 'utf8');
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// 정상 placeholder 형태 (정답)
const CORRECT_SERVER = `
'use strict';
const express = require('express');
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));
if (require.main === module) {
  const port = process.env.BE_PORT || 3001;
  app.listen(port, () => console.log('BE listening on', port));
}
module.exports = app;
`;

// ─────────── 정상 case ───────────

test('정상 placeholder 형태 → pass=true, violations 빈 배열', () => {
  const dir = mkBeRoot(CORRECT_SERVER);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, true);
    assert.deepEqual(r.violations, []);
    assert.equal(r.fix_instructions, '');
  } finally { cleanup(dir); }
});

test('server.js 부재 → skipped=no_server, pass=true (초기 cycle 안전)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csanity-noserver-'));
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, true);
    assert.equal(r.skipped, 'no_server');
  } finally { cleanup(dir); }
});

// ─────────── ① process.env.PORT ───────────

test('① process.env.PORT 사용 → PROCESS_ENV_PORT 위반 (사용자 보고 사고)', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    if (require.main === module) {
      const port = process.env.PORT || 3000;
      app.listen(port);
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].rule, 'PROCESS_ENV_PORT');
    assert.match(r.fix_instructions, /BE_PORT/);
  } finally { cleanup(dir); }
});

test('① BE_PORT는 false positive 아님 (process.env.BE_PORT는 정답)', () => {
  const dir = mkBeRoot(CORRECT_SERVER);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.violations.find((v) => v.rule === 'PROCESS_ENV_PORT'), undefined);
  } finally { cleanup(dir); }
});

test('① 주석 안의 process.env.PORT는 무시 (주석 strip)', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    // process.env.PORT 같은 PaaS 컨벤션은 안 씁니다 (주석)
    /* const x = process.env.PORT; */
    if (require.main === module) {
      const port = process.env.BE_PORT || 3001;
      app.listen(port);
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, true);
  } finally { cleanup(dir); }
});

// ─────────── ② app.listen(port, 'localhost') ───────────

test('② app.listen(port, "localhost") → LISTEN_LOCALHOST_ONLY 위반', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    if (require.main === module) {
      const port = process.env.BE_PORT || 3001;
      app.listen(port, 'localhost', () => console.log('listening'));
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, false);
    assert.ok(r.violations.find((v) => v.rule === 'LISTEN_LOCALHOST_ONLY'));
  } finally { cleanup(dir); }
});

test('② app.listen(port, "127.0.0.1") 도 위반', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    if (require.main === module) {
      app.listen(3001, '127.0.0.1');
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.ok(r.violations.find((v) => v.rule === 'LISTEN_LOCALHOST_ONLY'));
  } finally { cleanup(dir); }
});

test('② app.listen(port, "0.0.0.0") 는 OK (명시적 all-interface)', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    if (require.main === module) {
      const port = process.env.BE_PORT || 3001;
      app.listen(port, '0.0.0.0');
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.violations.find((v) => v.rule === 'LISTEN_LOCALHOST_ONLY'), undefined);
  } finally { cleanup(dir); }
});

// ─────────── ③ require.main 가드 부재 ───────────

test('③ app.listen() 가드 없이 top-level → MISSING_REQUIRE_MAIN_GUARD 위반', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    const port = process.env.BE_PORT || 3001;
    app.listen(port);     // ← 가드 없음
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, false);
    assert.ok(r.violations.find((v) => v.rule === 'MISSING_REQUIRE_MAIN_GUARD'));
  } finally { cleanup(dir); }
});

test('③ app.listen() 자체가 없으면 가드 위반도 안 잡힘 (test-only 모듈)', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    // listen 없음 — supertest 전용 모듈
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.violations.find((v) => v.rule === 'MISSING_REQUIRE_MAIN_GUARD'), undefined);
  } finally { cleanup(dir); }
});

// ─────────── ④ express.json() middleware 부재 ───────────

test('④ express.json() 없으면 MISSING_JSON_MIDDLEWARE 위반', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    // express.json 없음
    app.get('/health', (_req, res) => res.json({ ok: true }));
    if (require.main === module) {
      const port = process.env.BE_PORT || 3001;
      app.listen(port);
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, false);
    assert.ok(r.violations.find((v) => v.rule === 'MISSING_JSON_MIDDLEWARE'));
  } finally { cleanup(dir); }
});

test('④ destructure 형태 (const { json } = require("express"); app.use(json())) 도 인정', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const { json } = require('express');
    const app = express();
    app.use(json());
    app.get('/health', (_req, res) => res.json({ ok: true }));
    if (require.main === module) {
      const port = process.env.BE_PORT || 3001;
      app.listen(port);
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.violations.find((v) => v.rule === 'MISSING_JSON_MIDDLEWARE'), undefined);
  } finally { cleanup(dir); }
});

// ─────────── 통합 — 사용자 보고 사고 정확 재현 ───────────

test('🎯 사용자 보고 정확 재현 — process.env.PORT || 3000 + app.listen(port) 가드 있음', () => {
  // 실제 사고 BE/src/server.js와 동일 구조 (가드 있음, PORT만 잘못)
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    app.use(express.json());
    if (require.main === module) {
      const port = process.env.PORT || 3000;
      app.listen(port, () => console.log('BE listening on port', port));
    }
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].rule, 'PROCESS_ENV_PORT');
    // fix_instructions에 BE_PORT 안내 + Lint Stage 1 tag 포함
    assert.match(r.fix_instructions, /BE_PORT/);
    assert.match(r.fix_instructions, /LINT STAGE1/);
  } finally { cleanup(dir); }
});

test('🎯 4가지 모두 위반 — 4개 violations 모두 보고', () => {
  const dir = mkBeRoot(`
    const express = require('express');
    const app = express();
    // ① process.env.PORT, ② localhost host, ③ guard 없음, ④ express.json 없음
    const port = process.env.PORT || 3000;
    app.listen(port, 'localhost');
    module.exports = app;
  `);
  try {
    const r = checkBeServerSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations.length, 4);
    const rules = r.violations.map((v) => v.rule).sort();
    assert.deepEqual(rules, [
      'LISTEN_LOCALHOST_ONLY',
      'MISSING_JSON_MIDDLEWARE',
      'MISSING_REQUIRE_MAIN_GUARD',
      'PROCESS_ENV_PORT',
    ]);
  } finally { cleanup(dir); }
});

// ─────────── rules/be.md §3-zero 정합성 ───────────

test('rules/be.md §3-zero — 4 antipattern 모두 명시', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'be.md'), 'utf8');
  assert.match(md, /3-zero/);
  assert.match(md, /컨테이너 sanity/);
  assert.match(md, /process\.env\.PORT/);
  assert.match(md, /listen.*localhost/);
  assert.match(md, /require\.main === module/);
  assert.match(md, /express\.json\(\)/);
});
