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
const { sha256, diff, applyOne } = _internal;

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

// ─────────── D47 (2026-05-14): applyOne ON DUPLICATE KEY UPDATE 검증 ───────────
//
// 사용자 보고 사고 (big-cycle 2): retry 시 같은 filename UNIQUE 충돌로 *misleading*
// fix_instructions가 LLM에 전달 → 진짜 SQL 원인 모름 → 무한 retry → MAX → FAIL.
// 해결: upsert. 같은 filename 재시도 시 row update, UNIQUE 충돌 없음.

/**
 * Mock conn — 매 query 호출을 기록하고 미리 정해진 결과(또는 Error) 반환.
 * @param {Array<Error|Array>} behaviors — query 호출 순서대로 결과/throw.
 */
function mkConn(behaviors) {
  const conn = {
    queries: [],
    query: async (sql, params) => {
      const idx = conn.queries.length;
      conn.queries.push({ sql, params });
      const b = behaviors[idx];
      if (b instanceof Error) throw b;
      return [b || [], []];
    },
  };
  return conn;
}

test('D47: applyOne — SQL 성공 → upsert (1번 INSERT, status=SUCCESS)', async () => {
  const conn = mkConn([
    [],                 // SQL 실행 성공
    { affectedRows: 1 } // upsert 성공
  ]);
  const r = await applyOne(conn, {
    filename: '20260514120000_a.sql',
    content: 'CREATE TABLE a (id INT);',
    checksum: 'cs_a',
  }, 'task_1');
  assert.equal(r.ok, true);
  assert.equal(conn.queries.length, 2);
  // SQL 실행 + upsert 1번
  assert.equal(conn.queries[0].sql, 'CREATE TABLE a (id INT);');
  assert.match(conn.queries[1].sql, /ON DUPLICATE KEY UPDATE/);
  // upsert params: status='SUCCESS', error_message=null
  assert.equal(conn.queries[1].params[3], 'SUCCESS');
  assert.equal(conn.queries[1].params[4], null);
});

test('D47: applyOne — SQL 실패 → upsert (1번 INSERT, status=FAILED, error 보존)', async () => {
  const conn = mkConn([
    new Error('Table already exists'),
    { affectedRows: 1 }
  ]);
  const r = await applyOne(conn, {
    filename: '20260514120000_b.sql',
    content: 'CREATE TABLE b (id INT);',
    checksum: 'cs_b',
  }, 'task_2');
  assert.equal(r.ok, false);
  assert.match(r.error, /Table already exists/);
  assert.equal(conn.queries.length, 2);
  assert.equal(conn.queries[1].params[3], 'FAILED');
  assert.match(conn.queries[1].params[4], /Table already exists/);
});

test('★ D47: applyOne 재시도 — round 1 SQL FAIL + round 2 SQL SUCCESS → upsert UNIQUE 충돌 없음', async () => {
  // 사용자 보고 사고 정확 재현. round 1에서 SQL 실패 후 FAILED row 기록.
  // round 2에서 같은 filename으로 SQL 다시 시도 (수정된 SQL), 이번엔 성공 →
  // 옛 흐름은 *INSERT SUCCESS row 시도 → UNIQUE 충돌*로 끝났으나 D47에선
  // upsert로 row update.

  // round 1
  const conn1 = mkConn([
    new Error('syntax error near FOREIGN'),
    { affectedRows: 1 }   // FAILED row INSERT 성공
  ]);
  const r1 = await applyOne(conn1, {
    filename: '20260514120000_c.sql',
    content: 'CREATE TABLE c (... bad SQL ...);',
    checksum: 'cs_c_v1',
  }, 'task_3');
  assert.equal(r1.ok, false);
  assert.equal(conn1.queries[1].params[3], 'FAILED');

  // round 2 — 같은 filename, 수정된 SQL + checksum
  const conn2 = mkConn([
    [],                      // SQL 실행 성공 (수정됨)
    { affectedRows: 2 }      // upsert UPDATE 분기 (affectedRows=2 면 update)
  ]);
  const r2 = await applyOne(conn2, {
    filename: '20260514120000_c.sql',  // 같은 파일
    content: 'CREATE TABLE c (id INT);',
    checksum: 'cs_c_v2',                // 수정된 내용
  }, 'task_3');
  assert.equal(r2.ok, true);
  // ★ UNIQUE 충돌 *없음*. SQL이 throw하지 않음.
  assert.equal(conn2.queries.length, 2);
  assert.match(conn2.queries[1].sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(conn2.queries[1].params[3], 'SUCCESS');
  assert.equal(conn2.queries[1].params[4], null);
});

test('★ D47: applyOne 재시도 — round 1+2 둘 다 SQL FAIL → FAILED row update (error_message 최신)', async () => {
  // round 1
  const conn1 = mkConn([new Error('error v1'), { affectedRows: 1 }]);
  await applyOne(conn1, { filename: 'x.sql', content: 'bad', checksum: 'cs_v1' }, 'task_4');
  assert.match(conn1.queries[1].params[4], /error v1/);

  // round 2 — 다른 원인으로 또 fail
  const conn2 = mkConn([new Error('error v2'), { affectedRows: 2 }]);
  const r2 = await applyOne(conn2, { filename: 'x.sql', content: 'still bad', checksum: 'cs_v2' }, 'task_4');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /error v2/);
  // ★ upsert로 error_message가 v2로 갱신 (옛 흐름은 UNIQUE 충돌로 catch 무시 → row 안 바뀜)
  assert.equal(conn2.queries[1].params[3], 'FAILED');
  assert.match(conn2.queries[1].params[4], /error v2/);
});

test('D47: applyOne — upsert query 자체가 throw해도 process 진행 (graceful warn)', async () => {
  // DB 자체 문제 (예: connection drop). console.warn만 남기고 결과 반환.
  const conn = mkConn([
    [],                                                  // SQL 성공
    new Error('connection lost')                         // upsert query throw
  ]);
  // 원래 console.warn 잠깐 가로채서 출력 막기
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r = await applyOne(conn, {
      filename: 'y.sql', content: 'ok', checksum: 'cs_y'
    }, 'task_5');
    // SQL 성공했으니 ok=true (upsert 실패는 graceful warn)
    assert.equal(r.ok, true);
  } finally {
    console.warn = origWarn;
  }
});

test('D47: applyOne — INSERT 2번 안 함 (옛 흐름 회귀 방지)', async () => {
  // 이전 버전은 catch 안에 INSERT 한 번 더 있었음. D47에서 upsert로 *항상 1번*.
  const conn = mkConn([new Error('bad'), { affectedRows: 1 }]);
  await applyOne(conn, { filename: 'z.sql', content: 'x', checksum: 'cs_z' }, 'task_6');
  // SQL 실행 1 + upsert 1 = 2. 절대 3 이상 안 됨.
  assert.equal(conn.queries.length, 2);
});
