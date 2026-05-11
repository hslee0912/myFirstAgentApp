/**
 * Unit tests for lib/port_killer.js — pure helpers only.
 *
 * The kill path is integration territory (needs a real subject process,
 * different on every OS). We cover the deterministic surface:
 *   - parsePidList: PowerShell / lsof output → numeric set
 *   - classify: name → killable / protected / unknown bucket
 *   - allowlist + protect set shape
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePidList,
  classify,
  KILLABLE,
  PROTECTED,
} = require('../lib/port_killer');

// ─────────── parsePidList ───────────

test('parsePidList: parses PowerShell newline-separated output', () => {
  const raw = '12345\n67890\n';
  assert.deepEqual(parsePidList(raw).sort((a, b) => a - b), [12345, 67890]);
});

test('parsePidList: parses lsof space-separated output', () => {
  const raw = '1111 2222 3333';
  assert.deepEqual(parsePidList(raw).sort((a, b) => a - b), [1111, 2222, 3333]);
});

test('parsePidList: dedupes repeated PIDs', () => {
  assert.deepEqual(parsePidList('100\n100\n200\n'), [100, 200]);
});

test('parsePidList: filters non-numeric tokens silently', () => {
  assert.deepEqual(parsePidList('abc\n200\nfoo\n\n300\n').sort((a,b)=>a-b), [200, 300]);
});

test('parsePidList: skips zero and negative numbers', () => {
  assert.deepEqual(parsePidList('0\n-1\n42\n').sort((a,b)=>a-b), [42]);
});

test('parsePidList: handles empty / whitespace input', () => {
  assert.deepEqual(parsePidList(''), []);
  assert.deepEqual(parsePidList('   \n\n  '), []);
});

// ─────────── classify ───────────

test('classify: node and node.exe are killable', () => {
  assert.equal(classify('node'), 'killable');
  assert.equal(classify('node.exe'), 'killable');
  assert.equal(classify('NODE.EXE'), 'killable'); // case-insensitive
});

test('classify: mysqld / postgres / mongod / redis are protected', () => {
  assert.equal(classify('mysqld'), 'protected');
  assert.equal(classify('mysqld.exe'), 'protected');
  assert.equal(classify('postgres'), 'protected');
  assert.equal(classify('mongod'), 'protected');
  assert.equal(classify('redis-server'), 'protected');
});

test('classify: docker daemon family is protected', () => {
  assert.equal(classify('docker'), 'protected');
  assert.equal(classify('dockerd'), 'protected');
  assert.equal(classify('docker-proxy'), 'protected');
  assert.equal(classify('com.docker.service'), 'protected');
});

test('classify: windows system surface is protected', () => {
  assert.equal(classify('System'), 'protected');
  assert.equal(classify('services.exe'), 'protected');
  assert.equal(classify('svchost.exe'), 'protected');
});

test('classify: empty name (lookup failed) is opaque, not unknown', () => {
  // On Windows, tasklist returns nothing for processes that are dead
  // (orphaned TIME_WAIT socket) or admin-owned without elevation. Either
  // way the safe action is "skip" — but we distinguish opaque from unknown
  // so logs can explain which case it is.
  assert.equal(classify(''), 'opaque');
  assert.equal(classify(null), 'opaque');
  assert.equal(classify(undefined), 'opaque');
});

test('classify: everything else is unknown', () => {
  assert.equal(classify('chrome.exe'), 'unknown');
  assert.equal(classify('python.exe'), 'unknown');
  assert.equal(classify('nginx'), 'unknown');
});

// ─────────── set shape ───────────

test('KILLABLE: only contains node variants', () => {
  for (const n of KILLABLE) {
    assert.match(n, /^node(\.exe)?$/);
  }
});

test('PROTECTED: no node variant accidentally ends up here', () => {
  assert.ok(!PROTECTED.has('node'));
  assert.ok(!PROTECTED.has('node.exe'));
});

test('PROTECTED + KILLABLE: disjoint', () => {
  for (const k of KILLABLE) {
    assert.ok(!PROTECTED.has(k), `${k} appears in both sets`);
  }
});
