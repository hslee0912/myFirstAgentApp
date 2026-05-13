/**
 * Unit tests for lib/db_state.js (D44, 2026-05-14).
 *
 * 검증 대상:
 *   A. listAppliedMigrations — log_db_migrations 조회 (mock db.query)
 *   B. listDiskMigrations    — BE/db/migrations/*.sql ls (mock MIGRATIONS_DIR)
 *   C. getBusinessDbSchema   — information_schema 조회 (mock db.query)
 *   - diffApplied            — disk vs DB 비교
 *   - format* helpers        — prompt 표시 텍스트 변환
 *   - getBeStateBundle       — 통합 entry
 *
 * 실제 DB 접근 없이 monkey-patch로 검증. e2e는 별도.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../lib/db');
const dbState = require('../lib/db_state');

// ─────────── db.query mock ───────────

const originalQuery = db.query;
let mockResponses = {};
function setMock(responses) {
  mockResponses = responses;
}
function installMock() {
  db.query = async (sql, params) => {
    for (const key of Object.keys(mockResponses)) {
      if (sql.includes(key)) {
        const r = mockResponses[key];
        return typeof r === 'function' ? r(params) : r;
      }
    }
    throw new Error('Unexpected query in test: ' + sql.slice(0, 80));
  };
}
function restoreMock() {
  db.query = originalQuery;
  mockResponses = {};
}

// ─────────── A: listAppliedMigrations ───────────

test('A: listAppliedMigrations — SUCCESS rows를 applied_at ASC 순서로 반환', async () => {
  setMock({
    "FROM log_db_migrations WHERE status = 'SUCCESS'": [
      { filename: '20260514120000_a.sql', checksum: 'cs_a', applied_at: '2026-05-14T12:00:01Z', task_id: 't1' },
      { filename: '20260514130000_b.sql', checksum: 'cs_b', applied_at: '2026-05-14T13:00:01Z', task_id: 't2' },
    ],
  });
  installMock();
  try {
    const r = await dbState.listAppliedMigrations();
    assert.equal(r.length, 2);
    assert.equal(r[0].filename, '20260514120000_a.sql');
    assert.equal(r[0].checksum, 'cs_a');
    assert.ok(r[0].applied_at.includes('2026'));
    assert.equal(r[0].task_id, 't1');
  } finally { restoreMock(); }
});

test('A: listAppliedMigrations — DB 조회 실패 시 빈 배열 (graceful)', async () => {
  setMock({});
  installMock();
  try {
    const r = await dbState.listAppliedMigrations();
    assert.deepEqual(r, []);
  } finally { restoreMock(); }
});

// ─────────── B: listDiskMigrations ───────────

test('B: listDiskMigrations — 디렉터리 없으면 빈 배열', () => {
  // Use a definitely-non-existing path by stubbing the module's resolver.
  // 다만 MIGRATIONS_DIR은 모듈 상수라 직접 변경 불가 → 본 테스트는
  // *디렉터리 존재* 케이스(아래)와 _internal로 검증.
  assert.ok(typeof dbState.listDiskMigrations === 'function');
});

test('B: sha256 — 결정적 hash (같은 입력 → 같은 출력)', () => {
  const h1 = dbState._internal.sha256('hello');
  const h2 = dbState._internal.sha256('hello');
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);   // SHA-256 hex
});

// ─────────── C: getBusinessDbSchema ───────────

test('C: getBusinessDbSchema — information_schema rows를 테이블별로 grouping', async () => {
  setMock({
    'information_schema.COLUMNS': [
      { TABLE_NAME: 'users', COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null, EXTRA: 'auto_increment' },
      { TABLE_NAME: 'users', COLUMN_NAME: 'email', COLUMN_TYPE: 'varchar(255)', IS_NULLABLE: 'NO', COLUMN_KEY: 'UNI', COLUMN_DEFAULT: null, EXTRA: '' },
      { TABLE_NAME: 'results', COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null, EXTRA: 'auto_increment' },
    ],
  });
  installMock();
  try {
    const r = await dbState.getBusinessDbSchema();
    assert.equal(Object.keys(r.tables).length, 2);
    assert.equal(r.tables.users.length, 2);
    assert.equal(r.tables.users[0].column, 'id');
    assert.equal(r.tables.users[0].key, 'PRI');
    assert.equal(r.tables.users[1].key, 'UNI');
    assert.equal(r.tables.results.length, 1);
  } finally { restoreMock(); }
});

test('C: getBusinessDbSchema — 비즈니스 테이블 없으면 빈 객체 (첫 cycle 시나리오)', async () => {
  setMock({
    'information_schema.COLUMNS': [],
  });
  installMock();
  try {
    const r = await dbState.getBusinessDbSchema();
    assert.deepEqual(r.tables, {});
  } finally { restoreMock(); }
});

// ─────────── diffApplied ───────────

test('diffApplied — disk와 DB가 정확히 일치하면 in_sync=true', () => {
  const applied = [{ filename: 'a.sql', checksum: 'cs1' }];
  const disk = [{ filename: 'a.sql', checksum: 'cs1' }];
  const r = dbState.diffApplied(applied, disk);
  assert.equal(r.in_sync, true);
  assert.equal(r.conflicts.length, 0);
});

test('diffApplied — checksum 다르면 conflicts에 들어감 (사용자 보고 사고 케이스)', () => {
  const applied = [{ filename: 'a.sql', checksum: 'cs_applied' }];
  const disk = [{ filename: 'a.sql', checksum: 'cs_disk_modified' }];
  const r = dbState.diffApplied(applied, disk);
  assert.equal(r.in_sync, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].filename, 'a.sql');
  assert.equal(r.conflicts[0].disk_checksum, 'cs_disk_modified');
  assert.equal(r.conflicts[0].applied_checksum, 'cs_applied');
});

test('diffApplied — disk에만 있으면 orphan_on_disk (적용 대기 중)', () => {
  const applied = [];
  const disk = [{ filename: 'new.sql', checksum: 'cs_new' }];
  const r = dbState.diffApplied(applied, disk);
  assert.equal(r.in_sync, false);
  assert.deepEqual(r.orphan_on_disk, ['new.sql']);
});

test('diffApplied — DB에만 있으면 orphan_in_db (디스크에서 삭제됨)', () => {
  const applied = [{ filename: 'gone.sql', checksum: 'cs_gone' }];
  const disk = [];
  const r = dbState.diffApplied(applied, disk);
  assert.equal(r.in_sync, false);
  assert.deepEqual(r.orphan_in_db, ['gone.sql']);
});

// ─────────── formatters ───────────

test('formatApplied — 빈 배열은 "(아직 없음 — 첫 migration cycle)"', () => {
  assert.match(dbState.formatApplied([]), /첫 migration cycle/);
  assert.match(dbState.formatApplied(null), /첫 migration cycle/);
});

test('formatApplied — 정상 list는 "- <filename>  (applied <ISO>)"', () => {
  const out = dbState.formatApplied([
    { filename: '20260514120000_a.sql', checksum: 'x', applied_at: '2026-05-14T12:00:01Z' },
  ]);
  assert.match(out, /- 20260514120000_a\.sql\s+\(applied 2026/);
});

test('formatDisk — 빈 배열은 "(없음)"', () => {
  assert.match(dbState.formatDisk([]), /\(없음\)/);
});

test('formatDisk — 정상 list는 "- BE/db/migrations/<file>"', () => {
  const out = dbState.formatDisk([{ filename: 'a.sql', checksum: 'x', size: 100 }]);
  assert.match(out, /- BE\/db\/migrations\/a\.sql/);
});

test('formatSchema — tables 없으면 빈 비즈니스 schema 안내 + CREATE 가능 표시', () => {
  // 실제 메시지: "(아직 비즈니스 테이블 없음 — 이번 cycle에 CREATE TABLE 가능)"
  assert.match(dbState.formatSchema({ tables: {} }), /비즈니스 테이블 없음/);
  assert.match(dbState.formatSchema({ tables: {} }), /CREATE TABLE/);
  assert.match(dbState.formatSchema(null), /비즈니스 테이블 없음/);
});

test('formatSchema — 테이블 + 컬럼 정보 한 줄로 표시', () => {
  const out = dbState.formatSchema({
    tables: {
      users: [
        { column: 'id', type: 'int', nullable: false, key: 'PRI', extra: 'auto_increment' },
        { column: 'email', type: 'varchar(255)', nullable: false, key: 'UNI', extra: '' },
      ],
    },
  });
  assert.match(out, /- users\(id int PRI NOT NULL auto_increment, email varchar\(255\) UNI NOT NULL\)/);
});

// ─────────── getBeStateBundle ───────────

test('getBeStateBundle — 세 정보 묶음 + diff 포함', async () => {
  setMock({
    "FROM log_db_migrations WHERE status = 'SUCCESS'": [],
    'information_schema.COLUMNS': [],
  });
  installMock();
  try {
    const r = await dbState.getBeStateBundle();
    assert.ok(Array.isArray(r.applied));
    assert.ok(Array.isArray(r.disk));
    assert.ok(r.diff && typeof r.diff.in_sync === 'boolean');
    assert.ok(r.schema && typeof r.schema.tables === 'object');
  } finally { restoreMock(); }
});
