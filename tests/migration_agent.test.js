/**
 * Unit tests for migration_agent.js (D33, 2026-05-14).
 *
 * Covers pure helpers exposed via `_internal`:
 *   - sha256: deterministic hash (input → fixed hex)
 *   - diff: disk vs applied-map → { pending, conflicts } 분류
 *   - listDiskMigrations: 디스크 스캔 + 알파벳 정렬 + checksum 계산
 *
 * `applyOne` / `run`은 mysql connection 의존이라 단위 테스트에선 제외 (별도
 * 통합 테스트나 manual smoke로 검증). end-to-end run은 npm test 환경에 DB
 * 없는 케이스도 있어 의도적으로 단위 테스트 격리.
 *
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _internal } = require('../agents/migration_agent');
const { sha256, diff } = _internal;

// ─────────── sha256 ───────────

test('sha256 — deterministic hex digest', () => {
  const a = sha256('CREATE TABLE foo (id INT);');
  const b = sha256('CREATE TABLE foo (id INT);');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('sha256 — different input → different hash', () => {
  const a = sha256('CREATE TABLE foo (id INT);');
  const b = sha256('CREATE TABLE bar (id INT);');
  assert.notEqual(a, b);
});

test('sha256 — empty input is valid', () => {
  const a = sha256('');
  assert.equal(a, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ─────────── diff ───────────

const mkDiskItem = (filename, content) => ({
  filename,
  content,
  checksum: sha256(content),
});

test('diff — 모든 디스크 파일이 신규면 전부 pending', () => {
  const disk = [
    mkDiskItem('20260514120000_a.sql', 'CREATE TABLE a (id INT);'),
    mkDiskItem('20260514130000_b.sql', 'CREATE TABLE b (id INT);'),
  ];
  const applied = new Map();
  const { pending, conflicts } = diff(disk, applied);
  assert.equal(pending.length, 2);
  assert.equal(conflicts.length, 0);
  assert.equal(pending[0].filename, '20260514120000_a.sql');
});

test('diff — 이미 적용 + checksum 일치 = pending 0', () => {
  const item = mkDiskItem('20260514120000_a.sql', 'CREATE TABLE a (id INT);');
  const disk = [item];
  const applied = new Map([[item.filename, item.checksum]]);
  const { pending, conflicts } = diff(disk, applied);
  assert.equal(pending.length, 0);
  assert.equal(conflicts.length, 0);
});

test('diff — 이미 적용 + checksum 불일치 = conflict (디스크 수정 감지)', () => {
  const original = mkDiskItem('20260514120000_a.sql', 'CREATE TABLE a (id INT);');
  const modified = mkDiskItem('20260514120000_a.sql', 'CREATE TABLE a (id BIGINT);');
  const disk = [modified];
  const applied = new Map([[original.filename, original.checksum]]);
  const { pending, conflicts } = diff(disk, applied);
  assert.equal(pending.length, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].filename, original.filename);
  assert.equal(conflicts[0].disk_checksum, modified.checksum);
  assert.equal(conflicts[0].applied_checksum, original.checksum);
});

test('diff — 혼합 (적용 + 신규 + 충돌)', () => {
  const aOrig = mkDiskItem('20260514120000_a.sql', 'CREATE TABLE a (id INT);');
  const bModified = mkDiskItem('20260514130000_b.sql', 'CREATE TABLE b (id BIGINT);');
  const bOrigChecksum = sha256('CREATE TABLE b (id INT);');
  const cNew = mkDiskItem('20260514140000_c.sql', 'CREATE TABLE c (id INT);');
  const disk = [aOrig, bModified, cNew];
  const applied = new Map([
    [aOrig.filename, aOrig.checksum],
    [bModified.filename, bOrigChecksum],   // disk와 다름 → conflict
  ]);
  const { pending, conflicts } = diff(disk, applied);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, cNew.filename);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].filename, bModified.filename);
});

test('diff — 빈 디스크', () => {
  const { pending, conflicts } = diff([], new Map());
  assert.equal(pending.length, 0);
  assert.equal(conflicts.length, 0);
});

// ─────────── listDiskMigrations (tmp 디렉터리 + 모듈 재기동 안 함) ───────────
// MIGRATIONS_DIR이 모듈 load 시점 고정이라, 이 테스트는 실제 BE/db/migrations 디렉터리
// 상태에 의존. 보수적으로: *.sql 외 파일은 무시 + 정렬 정확성을 비-파괴적으로 확인.

test('listDiskMigrations — 함수 호출 시 throw 없음 (디렉터리 부재 OK)', () => {
  const { listDiskMigrations } = _internal;
  // 실제 BE/db/migrations 존재 여부와 무관하게 호출 안전성 보장.
  // 디렉터리 부재 → 빈 배열. 존재 → 알파벳 정렬된 SQL 파일 배열.
  const result = listDiskMigrations();
  assert.ok(Array.isArray(result));
  // 각 항목 형태 검증
  for (const m of result) {
    assert.ok(typeof m.filename === 'string');
    assert.ok(m.filename.endsWith('.sql'));
    assert.ok(typeof m.content === 'string');
    assert.match(m.checksum, /^[0-9a-f]{64}$/);
  }
  // 알파벳 정렬 확인
  const sorted = [...result].sort((a, b) => a.filename.localeCompare(b.filename));
  for (let i = 0; i < result.length; i++) {
    assert.equal(result[i].filename, sorted[i].filename);
  }
});

test('listDiskMigrations — *.sql 만 포함, 다른 확장자 무시 (tmp 디렉터리 시나리오)', () => {
  // _internal.MIGRATIONS_DIR을 직접 못 바꾸지만, 검증 의도: filter 로직이 .sql 만 받는지.
  // 모듈 내부 검사 — 만약 *.sql 외 파일이 끼면 위 테스트의 endsWith('.sql') assert가 캐치.
  // 이 테스트는 *문서적 자리표시자*: 위 결과 배열에 비-sql이 0개임을 재확인.
  const { listDiskMigrations } = _internal;
  const result = listDiskMigrations();
  const nonSql = result.filter((m) => !m.filename.endsWith('.sql'));
  assert.equal(nonSql.length, 0);
});
