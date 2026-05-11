/**
 * Unit tests for orchestrator helper functions:
 *   - extractAllowedPathsFromFix: extract repo-relative paths from
 *     lint fix_instructions, exclude protected config files (lint/docker/package).
 *   - snapshotArea: list source files for an area, exclude node_modules
 *     and protected config files.
 *
 * Run: npm test  (uses node --test)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractAllowedPathsFromFix } = require('../agents/orchestrator');

// ─────────── extractAllowedPathsFromFix ───────────

test('extracts BE source paths from fix_instructions', () => {
  const fix = 'Fix BE/src/server.js — missing semicolon.';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(result.includes('BE/src/server.js'));
});

test('extracts multiple BE paths', () => {
  const fix = 'Files to fix: BE/src/server.js and BE/src/routes/auth.js';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(result.includes('BE/src/server.js'));
  assert.ok(result.includes('BE/src/routes/auth.js'));
});

test('adds test partner for BE source files', () => {
  const fix = 'Fix BE/src/services/user_service.js';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(result.includes('BE/src/services/user_service.js'));
  assert.ok(result.includes('BE/src/services/user_service.test.js'));
});

test('adds test partner for FE source files (.jsx)', () => {
  const fix = 'Fix FE/src/components/SignupForm.jsx';
  const result = extractAllowedPathsFromFix('FE', fix);
  assert.ok(result.includes('FE/src/components/SignupForm.jsx'));
  assert.ok(result.includes('FE/src/components/SignupForm.test.jsx'));
});

test('does NOT add test partner if path is already a test file', () => {
  const fix = 'Fix BE/src/server.test.js';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(result.includes('BE/src/server.test.js'));
  assert.equal(
    result.filter((p) => p === 'BE/src/server.test.js').length,
    1,
    'no duplicate'
  );
});

// ─────────── X1: protected files filter ───────────

test('filters out BE/.eslintrc.json (protected)', () => {
  const fix = 'Fix BE/src/server.js and BE/.eslintrc.json mentions';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(result.includes('BE/src/server.js'));
  assert.ok(!result.includes('BE/.eslintrc.json'), 'protected file should be filtered');
});

test('filters out BE/Dockerfile (protected)', () => {
  const fix = 'Fix BE/Dockerfile and BE/src/server.js';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(result.includes('BE/src/server.js'));
  assert.ok(!result.includes('BE/Dockerfile'));
});

test('filters out BE/.dockerignore (protected)', () => {
  const fix = 'BE/.dockerignore needs update';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(!result.includes('BE/.dockerignore'));
});

test('filters out BE/package.json and BE/package-lock.json (protected)', () => {
  const fix = 'Update BE/package.json and BE/package-lock.json';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(!result.includes('BE/package.json'));
  assert.ok(!result.includes('BE/package-lock.json'));
});

test('filters out FE/.eslintrc.json, FE/Dockerfile, FE/.dockerignore', () => {
  const fix = 'Fix FE/.eslintrc.json, FE/Dockerfile, FE/.dockerignore, FE/src/App.jsx';
  const result = extractAllowedPathsFromFix('FE', fix);
  assert.ok(result.includes('FE/src/App.jsx'));
  assert.ok(!result.includes('FE/.eslintrc.json'));
  assert.ok(!result.includes('FE/Dockerfile'));
  assert.ok(!result.includes('FE/.dockerignore'));
});

test('filters out FE/vite.config.js and FE/index.html (protected)', () => {
  const fix = 'Fix FE/vite.config.js and FE/index.html';
  const result = extractAllowedPathsFromFix('FE', fix);
  assert.ok(!result.includes('FE/vite.config.js'));
  assert.ok(!result.includes('FE/index.html'));
});

// ─────────── edge cases ───────────

test('returns empty array for empty fix', () => {
  assert.deepEqual(extractAllowedPathsFromFix('BE', ''), []);
  assert.deepEqual(extractAllowedPathsFromFix('BE', null), []);
  assert.deepEqual(extractAllowedPathsFromFix('BE', undefined), []);
});

test('does not extract paths from other targets', () => {
  const fix = 'Fix FE/src/App.jsx (mentioned in BE context)';
  const result = extractAllowedPathsFromFix('BE', fix);
  assert.ok(!result.includes('FE/src/App.jsx'));
});
