/**
 * Unit tests for lib/prompt_util.js — abridgeExistingFiles / abridgeForRetry.
 *
 * Run: npm test  (uses node --test, no extra dependency)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { abridgeExistingFiles, abridgeForRetry, dropProtectedFiles, validateAllowedDeps } = require('../lib/prompt_util');

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

// ─────────── dropProtectedFiles (Y) ───────────

test('dropProtectedFiles: removes protected files from response', () => {
  const result = dropProtectedFiles(
    { 'BE/src/server.js': 'A', 'BE/.eslintrc.json': 'B' },
    ['BE/.eslintrc.json', 'BE/Dockerfile']
  );
  assert.deepEqual(Object.keys(result.files), ['BE/src/server.js']);
  assert.deepEqual(result.dropped, ['BE/.eslintrc.json']);
});

test('dropProtectedFiles: keeps non-protected files', () => {
  const result = dropProtectedFiles(
    { 'BE/src/a.js': '1', 'BE/src/b.js': '2' },
    ['BE/.eslintrc.json']
  );
  assert.deepEqual(Object.keys(result.files), ['BE/src/a.js', 'BE/src/b.js']);
  assert.deepEqual(result.dropped, []);
});

test('dropProtectedFiles: drops multiple protected, preserves order', () => {
  const result = dropProtectedFiles(
    {
      'BE/src/server.js': 'A',
      'BE/.eslintrc.json': 'B',
      'BE/Dockerfile': 'C',
      'BE/src/routes/auth.js': 'D',
    },
    ['BE/.eslintrc.json', 'BE/Dockerfile']
  );
  assert.deepEqual(Object.keys(result.files), ['BE/src/server.js', 'BE/src/routes/auth.js']);
  assert.deepEqual(result.dropped, ['BE/.eslintrc.json', 'BE/Dockerfile']);
});

test('dropProtectedFiles: empty protectedList keeps everything', () => {
  const result = dropProtectedFiles(
    { 'a.js': '1', 'b.js': '2' },
    []
  );
  assert.deepEqual(Object.keys(result.files), ['a.js', 'b.js']);
  assert.deepEqual(result.dropped, []);
});

test('dropProtectedFiles: handles empty/null files input', () => {
  assert.deepEqual(dropProtectedFiles({}, ['BE/x']), { files: {}, dropped: [] });
  assert.deepEqual(dropProtectedFiles(null, ['BE/x']), { files: {}, dropped: [] });
  assert.deepEqual(dropProtectedFiles(undefined, ['BE/x']), { files: {}, dropped: [] });
});

test('dropProtectedFiles: handles null protectedList', () => {
  const result = dropProtectedFiles({ 'a.js': '1' }, null);
  assert.deepEqual(Object.keys(result.files), ['a.js']);
  assert.deepEqual(result.dropped, []);
});

// ─────────── validateAllowedDeps ───────────

test('validateAllowedDeps: passes when all requires are allowed', () => {
  const files = {
    'BE/src/server.js': `const express = require('express');\nconst bcrypt = require('bcrypt');`,
  };
  assert.doesNotThrow(() =>
    validateAllowedDeps(files, 'express, bcrypt, mysql2', 'BE Agent')
  );
});

test('validateAllowedDeps: throws on unauthorized require', () => {
  const files = {
    'BE/src/auth.js': `const validator = require('email-validator');`,
  };
  assert.throws(
    () => validateAllowedDeps(files, 'express, bcrypt', 'BE Agent'),
    (err) => err.code === 'UNAUTHORIZED_DEPS' && /email-validator/.test(err.message)
  );
});

test('validateAllowedDeps: throws on unauthorized ES import', () => {
  const files = {
    'FE/src/App.jsx': `import axios from 'axios';\nimport { useState } from 'react';`,
  };
  assert.throws(
    () => validateAllowedDeps(files, 'react, react-dom', 'FE Agent'),
    (err) => err.code === 'UNAUTHORIZED_DEPS' && /axios/.test(err.message)
  );
});

test('validateAllowedDeps: allows relative paths', () => {
  const files = {
    'BE/src/server.js': `const auth = require('./routes/auth');\nconst util = require('../lib/util');`,
  };
  assert.doesNotThrow(() => validateAllowedDeps(files, '', 'BE Agent'));
});

test('validateAllowedDeps: allows Node builtins', () => {
  const files = {
    'BE/src/util.js': `const fs = require('fs');\nconst path = require('node:path');\nconst { isBuiltin } = require('module');`,
  };
  assert.doesNotThrow(() => validateAllowedDeps(files, 'express', 'BE Agent'));
});

test('validateAllowedDeps: handles scoped packages', () => {
  const files = {
    'FE/src/Test.jsx': `import { render } from '@testing-library/react';\nimport '@testing-library/jest-dom';`,
  };
  assert.doesNotThrow(() =>
    validateAllowedDeps(files, '@testing-library/react, @testing-library/jest-dom', 'FE Agent')
  );
});

test('validateAllowedDeps: throws on unauthorized scoped package', () => {
  const files = {
    'FE/src/Style.jsx': `import styled from '@emotion/styled';`,
  };
  assert.throws(
    () => validateAllowedDeps(files, 'react', 'FE Agent'),
    (err) => err.code === 'UNAUTHORIZED_DEPS' && /@emotion\/styled/.test(err.message)
  );
});

test('validateAllowedDeps: accepts array allowedDeps as well as csv string', () => {
  const files = { 'a.js': `const x = require('express');` };
  assert.doesNotThrow(() => validateAllowedDeps(files, ['express'], 'L'));
  assert.doesNotThrow(() => validateAllowedDeps(files, 'express', 'L'));
});

test('validateAllowedDeps: handles deep import path (e.g. mysql2/promise)', () => {
  const files = {
    'BE/src/db.js': `const mysql = require('mysql2/promise');\nconst pool = mysql.createPool({});`,
  };
  assert.doesNotThrow(() => validateAllowedDeps(files, 'mysql2', 'BE Agent'));
});

test('validateAllowedDeps: skips non-js files', () => {
  const files = {
    'BE/src/data.json': '{"requires": "evil"}',
    'BE/README.md': "require('whatever')",
  };
  assert.doesNotThrow(() => validateAllowedDeps(files, '', 'BE Agent'));
});

test('validateAllowedDeps: violations list shape', () => {
  const files = {
    'BE/src/auth.js': `const v = require('email-validator');\nconst j = require('joi');`,
  };
  try {
    validateAllowedDeps(files, 'express', 'BE Agent');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'UNAUTHORIZED_DEPS');
    assert.equal(e.violations.length, 2);
    const mods = e.violations.map((v) => v.module).sort();
    assert.deepEqual(mods, ['email-validator', 'joi']);
  }
});

test('validateAllowedDeps: handles empty/null files input', () => {
  assert.doesNotThrow(() => validateAllowedDeps({}, 'express', 'L'));
  assert.doesNotThrow(() => validateAllowedDeps(null, 'express', 'L'));
  assert.doesNotThrow(() => validateAllowedDeps(undefined, 'express', 'L'));
});
