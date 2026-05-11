/**
 * Unit tests for lib/prompt_util.js — abridgeExistingFiles / abridgeForRetry.
 *
 * Run: npm test  (uses node --test, no extra dependency)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { abridgeExistingFiles, abridgeForRetry } = require('../lib/prompt_util');

// ─────────── abridgeExistingFiles ───────────

test('abridgeExistingFiles: keeps small files (<=100 lines) intact', () => {
  const small = Array.from({ length: 50 }, (_, i) => `line_${i}`).join('\n');
  const result = abridgeExistingFiles({ 'src/small.js': small });
  assert.equal(result['src/small.js'], small);
});

test('abridgeExistingFiles: abridges large files with [중략] marker', () => {
  const big = Array.from({ length: 200 }, (_, i) => `line_${i}`).join('\n');
  const result = abridgeExistingFiles({ 'src/big.js': big });
  assert.match(result['src/big.js'], /중략/);
  assert.ok(result['src/big.js'].length < big.length, 'abridged size should be smaller');
});

test('abridgeExistingFiles: preserves head and tail', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line_${i}`);
  const big = lines.join('\n');
  const result = abridgeExistingFiles({ 'src/big.js': big });
  assert.match(result['src/big.js'], /^line_0\n/, 'head preserved');
  assert.match(result['src/big.js'], /line_199$/, 'tail preserved');
});

test('abridgeExistingFiles: keeps .test.js intact regardless of size', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line_${i}`).join('\n');
  const result = abridgeExistingFiles({ 'src/foo.test.js': big });
  assert.equal(result['src/foo.test.js'], big);
});

test('abridgeExistingFiles: keeps .test.jsx intact regardless of size', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line_${i}`).join('\n');
  const result = abridgeExistingFiles({ 'src/Foo.test.jsx': big });
  assert.equal(result['src/Foo.test.jsx'], big);
});

test('abridgeExistingFiles: handles empty/null input', () => {
  assert.deepEqual(abridgeExistingFiles({}), {});
  assert.deepEqual(abridgeExistingFiles(null), {});
  assert.deepEqual(abridgeExistingFiles(undefined), {});
});

test('abridgeExistingFiles: respects custom keepFullSizeLimit', () => {
  const lines50 = Array.from({ length: 50 }, (_, i) => `line_${i}`).join('\n');
  const result = abridgeExistingFiles(
    { 'src/medium.js': lines50 },
    { keepFullSizeLimit: 30 }
  );
  assert.match(result['src/medium.js'], /중략/, 'should abridge with stricter limit');
});

// ─────────── abridgeForRetry ───────────

test('abridgeForRetry: keeps allowed paths in full', () => {
  const result = abridgeForRetry(
    {
      'BE/src/server.js': 'CONTENT_A_LONG',
      'BE/src/routes/auth.js': 'CONTENT_B_LONG',
    },
    ['BE/src/routes/auth.js']
  );
  assert.equal(result['BE/src/routes/auth.js'], 'CONTENT_B_LONG');
  assert.match(result['BE/src/server.js'], /unchanged file/);
  assert.match(result['BE/src/server.js'], /not in allowed_paths/);
});

test('abridgeForRetry: stub includes line count', () => {
  const result = abridgeForRetry(
    { 'BE/src/server.js': 'a\nb\nc\nd\ne' },
    [] // nothing allowed
  );
  assert.match(result['BE/src/server.js'], /5 lines/);
});

test('abridgeForRetry: handles empty/null input', () => {
  assert.deepEqual(abridgeForRetry({}, []), {});
  assert.deepEqual(abridgeForRetry(null, []), {});
  assert.deepEqual(abridgeForRetry(undefined, []), {});
});

test('abridgeForRetry: empty allowed_paths stubs everything', () => {
  const result = abridgeForRetry(
    { 'a.js': 'aaa', 'b.js': 'bbb' },
    []
  );
  assert.match(result['a.js'], /unchanged file/);
  assert.match(result['b.js'], /unchanged file/);
});
