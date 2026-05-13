/**
 * Unit tests for lib/env_writer.js — readEnv + updateEnv (atomic, key-scoped).
 *
 * Run: npm test
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readEnv, updateEnv, UI_EDITABLE_KEYS, TOGGLE_KEYS, ADVANCED_KEYS } = require('../lib/env_writer');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-writer-'));
after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ─────────── readEnv ───────────

test('readEnv: parses key=value pairs', () => {
  const p = tmpFile('a.env', 'FOO=1\nBAR=hello\n');
  assert.deepEqual(readEnv(p), { FOO: '1', BAR: 'hello' });
});

test('readEnv: ignores comments and blank lines', () => {
  const p = tmpFile('b.env', '# comment\n\nFOO=1\n# inline=skipped\nBAR=2\n');
  assert.deepEqual(readEnv(p), { FOO: '1', BAR: '2' });
});

test('readEnv: strips matching single/double quotes', () => {
  const p = tmpFile('c.env', 'A="quoted"\nB=\'single\'\nC=raw\n');
  assert.deepEqual(readEnv(p), { A: 'quoted', B: 'single', C: 'raw' });
});

test('readEnv: missing file → empty object', () => {
  assert.deepEqual(readEnv(path.join(tmpDir, 'does-not-exist.env')), {});
});

// ─────────── updateEnv: in-place key replacement ───────────

test('updateEnv: updates existing key, leaves others + comments + order intact', () => {
  const initial =
    '# header\nFOO=1\n# between\nBAR=2\nBAZ=3\n';
  const p = tmpFile('d.env', initial);
  const result = updateEnv(p, { BAR: 'new' });
  const after = fs.readFileSync(p, 'utf8');
  assert.equal(after, '# header\nFOO=1\n# between\nBAR=new\nBAZ=3\n');
  assert.deepEqual(result.updated, ['BAR']);
  assert.deepEqual(result.appended, []);
});

test('updateEnv: appends missing keys with blank-line separator', () => {
  const p = tmpFile('e.env', 'FOO=1\n');
  const result = updateEnv(p, { BAR: '2', BAZ: '3' });
  const after = fs.readFileSync(p, 'utf8');
  assert.match(after, /^FOO=1\n\nBAR=2\nBAZ=3\n$/);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.appended.sort(), ['BAR', 'BAZ']);
});

test('updateEnv: mixes update + append in one call', () => {
  const p = tmpFile('f.env', 'A=old\nB=keep\n');
  const result = updateEnv(p, { A: 'new', C: 'fresh' });
  const after = fs.readFileSync(p, 'utf8');
  assert.match(after, /^A=new\nB=keep\n\nC=fresh\n$/);
  assert.deepEqual(result.updated, ['A']);
  assert.deepEqual(result.appended, ['C']);
});

test('updateEnv: preserves CRLF line endings when input uses them', () => {
  const p = tmpFile('g.env', 'A=1\r\nB=2\r\n');
  updateEnv(p, { A: 'new' });
  const after = fs.readFileSync(p, 'utf8');
  assert.equal(after, 'A=new\r\nB=2\r\n');
});

test('updateEnv: numbers and booleans get stringified', () => {
  const p = tmpFile('h.env', 'A=old\n');
  updateEnv(p, { A: 42, B: true });
  const got = readEnv(p);
  assert.equal(got.A, '42');
  assert.equal(got.B, 'true');
});

test('updateEnv: atomic via .tmp + rename (no .tmp leaks on success)', () => {
  const p = tmpFile('i.env', 'A=1\n');
  updateEnv(p, { A: '2' });
  assert.ok(!fs.existsSync(`${p}.tmp`));
  assert.equal(readEnv(p).A, '2');
});

test('updateEnv: creating a new file when the path does not exist', () => {
  const p = path.join(tmpDir, 'new-file.env');
  updateEnv(p, { FOO: 'bar' });
  assert.equal(readEnv(p).FOO, 'bar');
});

// ─────────── UI_EDITABLE_KEYS shape ───────────

test('UI_EDITABLE_KEYS: frozen allowlist with the expected mode toggles', () => {
  assert.ok(Object.isFrozen(UI_EDITABLE_KEYS));
  assert.ok(UI_EDITABLE_KEYS.includes('COMMIT_MODE'));
  assert.ok(UI_EDITABLE_KEYS.includes('VALIDATION_MODE'));
  assert.ok(UI_EDITABLE_KEYS.includes('DEPLOY_MODE'));
  // Sensitive keys must NOT be on the allowlist.
  assert.ok(!UI_EDITABLE_KEYS.includes('ANTHROPIC_API_KEY'));
  assert.ok(!UI_EDITABLE_KEYS.includes('DB_PASSWORD'));
  assert.ok(!UI_EDITABLE_KEYS.includes('UI_PORT')); // UI shouldn't move its own port at runtime
});

// ─────────── D37 (2026-05-14): TOGGLE_KEYS / ADVANCED_KEYS 분리 ───────────

test('TOGGLE_KEYS: 4개 토글만 (frozen) — UI 인라인 패널에 노출되는 키', () => {
  assert.ok(Object.isFrozen(TOGGLE_KEYS));
  assert.deepEqual(
    [...TOGGLE_KEYS].sort(),
    ['COMMIT_MODE', 'DEPLOY_MODE', 'DEPLOY_TEARDOWN_ON_PASS', 'VALIDATION_MODE'].sort()
  );
});

test('ADVANCED_KEYS: frozen + 토글 외의 모든 editable 키 포함', () => {
  assert.ok(Object.isFrozen(ADVANCED_KEYS));
  // 모델·포트·타임아웃 같은 대표 키들이 advanced에 있어야 함
  assert.ok(ADVANCED_KEYS.includes('ANTHROPIC_MODEL'));
  assert.ok(ADVANCED_KEYS.includes('DEPLOY_PORT_BE'));
  assert.ok(ADVANCED_KEYS.includes('MAX_RETRIES'));
  assert.ok(ADVANCED_KEYS.includes('PUBLIC_HOST'));
  // 토글 키는 ADVANCED에 없어야 함
  for (const k of TOGGLE_KEYS) {
    assert.ok(!ADVANCED_KEYS.includes(k), `${k}는 TOGGLE_KEYS인데 ADVANCED_KEYS에도 있음`);
  }
});

test('TOGGLE_KEYS ∪ ADVANCED_KEYS = UI_EDITABLE_KEYS (분리는 레이아웃만, allowlist 동일)', () => {
  const union = new Set([...TOGGLE_KEYS, ...ADVANCED_KEYS]);
  const editable = new Set(UI_EDITABLE_KEYS);
  assert.equal(union.size, editable.size);
  for (const k of editable) assert.ok(union.has(k), `UI_EDITABLE에 ${k}가 있는데 분리된 두 그룹엔 없음`);
  // 길이 합 = UI_EDITABLE_KEYS (disjoint 보장 — 위 테스트와 함께)
  assert.equal(TOGGLE_KEYS.length + ADVANCED_KEYS.length, UI_EDITABLE_KEYS.length);
});

test('TOGGLE_KEYS ∩ ADVANCED_KEYS = ∅ (disjoint)', () => {
  for (const k of TOGGLE_KEYS) {
    assert.ok(!ADVANCED_KEYS.includes(k), `${k}가 양쪽 모두에 있음`);
  }
  for (const k of ADVANCED_KEYS) {
    assert.ok(!TOGGLE_KEYS.includes(k), `${k}가 양쪽 모두에 있음`);
  }
});
