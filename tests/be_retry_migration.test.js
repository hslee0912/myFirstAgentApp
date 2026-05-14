/**
 * Integration-style unit tests — BE Agent retry × Migration Agent interaction
 * (D46, 2026-05-14, 사용자 요청).
 *
 * 핵심 시나리오: round 1에서 BE가 *migration 파일을 emit 후 Lint FAIL* → round 2에
 * BE Agent가 retry 호출됨. 그때 *이미 적용된 migration 파일*에 대해 다음 세 가지
 * 동작이 정확해야 함:
 *
 *   (a) 같은 파일 + 같은 내용 (LLM이 *수정 안 함*) → migration agent skip (재적용 X)
 *   (b) 같은 파일 + 다른 내용 (LLM이 *내용 수정* — 사고) → conflicts (사용자 보고 사고 차단)
 *   (c) 새 timestamp 파일만 추가 (LLM이 ALTER로 보강 — 정답) → 새 파일만 pending
 *
 * migration_agent의 `_internal.diff`를 직접 호출해 격리 검증. mysql 미접근.
 *
 * 추가: D44에서 BE Agent prompt에 inject되는 *applied list* + *disk list*가
 * 실제 disk·DB 상태와 일치하는지 db_state helper들로 검증.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _internal: migInternal } = require('../agents/migration_agent');
const { sha256, diff } = migInternal;

const dbState = require('../lib/db_state');

// ─────────── helpers ───────────

const mkDisk = (filename, content) => ({
  filename,
  content,
  checksum: sha256(content),
});

// LLM이 round 1에서 emit한 migration (성공 적용됨)
const ROUND1_MIGRATION = mkDisk(
  '20260514120000_create_player_users.sql',
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash CHAR(60) NOT NULL
  );`
);

// log_db_migrations에 status=SUCCESS로 기록된 상태 → Map<filename, checksum>
const ROUND1_APPLIED_MAP = new Map([
  [ROUND1_MIGRATION.filename, ROUND1_MIGRATION.checksum],
]);

// ─────────── (a) round 2: LLM이 *같은 파일을 수정하지 않고* 보존 ───────────

test('★ (a) round 2 retry — LLM이 migration 파일 *그대로 보존* → skip (재적용 X)', () => {
  // round 1 emit한 파일이 디스크에 그대로 있고, LLM이 round 2에 ALTER를 *새 파일*로 emit
  // 그런데 이 (a) 시나리오는 BE Agent가 *migration 영역엔 손 안 댐* — Lint FAIL 수정만.
  const disk = [ROUND1_MIGRATION];  // 변경 없음
  const r = diff(disk, ROUND1_APPLIED_MAP);
  assert.equal(r.pending.length, 0, '이미 적용된 파일은 pending에 들어가면 안 됨');
  assert.equal(r.conflicts.length, 0, 'checksum 같으니 conflict 0');
  // → migration agent는 *이번 round에 아무것도 적용 안 함*. 정상 idempotent.
});

// ─────────── (b) round 2: LLM이 *같은 파일을 잘못 수정* (사용자 보고 사고) ───────────

test('★ (b) round 2 retry — LLM이 같은 파일에 컬럼 추가 시도 → checksum 충돌 감지', () => {
  // LLM이 사용자 보고 사고 패턴 재현: CREATE TABLE에 player_name 컬럼을 *나중에 끼워넣음*
  const modified = mkDisk(
    ROUND1_MIGRATION.filename,    // 같은 파일명!
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash CHAR(60) NOT NULL,
      player_name VARCHAR(50) NOT NULL  -- ← 새로 끼워넣음 → checksum 변경
    );`
  );
  assert.notEqual(modified.checksum, ROUND1_MIGRATION.checksum, 'checksum이 바뀌어야 conflict 검출 의미');

  const disk = [modified];
  const r = diff(disk, ROUND1_APPLIED_MAP);
  assert.equal(r.pending.length, 0, '이미 적용된 파일은 pending 안 됨');
  assert.equal(r.conflicts.length, 1, '★ 정확히 1개 conflict (사용자 보고 사고 차단)');
  assert.equal(r.conflicts[0].filename, ROUND1_MIGRATION.filename);
  assert.equal(r.conflicts[0].disk_checksum, modified.checksum);
  assert.equal(r.conflicts[0].applied_checksum, ROUND1_MIGRATION.checksum);
  // → migration agent는 즉시 FAIL. fix_instructions로 "checksum 충돌 + 새 timestamp 파일로
  //   ALTER" 안내. 이게 D41 rules/db.md §3에 안내된 정답 경로.
});

// ─────────── (c) round 2: LLM이 *새 timestamp의 새 파일*로 ALTER (정답 패턴) ───────────

test('★ (c) round 2 retry — LLM이 *새 timestamp 파일*로 ALTER → 새 파일만 pending', () => {
  // rules/db.md §3이 안내한 *정답 패턴*: 새 timestamp + ALTER
  const newMigration = mkDisk(
    '20260514131500_add_player_name_to_users.sql',
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS player_name VARCHAR(50) NOT NULL DEFAULT '';`
  );

  const disk = [ROUND1_MIGRATION, newMigration];
  const r = diff(disk, ROUND1_APPLIED_MAP);
  assert.equal(r.pending.length, 1, '★ 새 파일 1개만 pending (기존 파일은 skip)');
  assert.equal(r.pending[0].filename, newMigration.filename);
  assert.equal(r.conflicts.length, 0, 'conflict 0 (정답 패턴이므로)');
  // → migration agent가 새 파일만 적용. 이게 우리가 LLM에게 가르치고 싶은 흐름.
});

// ─────────── (d) edge: 같은 cycle에 2개 새 migration 동시 emit ───────────

test('(d) round 2 retry — 새 migration 2개 동시 emit → 알파벳 순서로 pending', () => {
  const newA = mkDisk('20260514131500_add_player_name.sql', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS player_name VARCHAR(50);');
  const newB = mkDisk('20260514131600_add_index.sql', 'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');

  const disk = [ROUND1_MIGRATION, newA, newB];  // 디스크 list는 알파벳 정렬됨 (listDiskMigrations 보장)
  const r = diff(disk, ROUND1_APPLIED_MAP);
  assert.equal(r.pending.length, 2);
  assert.equal(r.pending[0].filename, newA.filename);
  assert.equal(r.pending[1].filename, newB.filename);
  // → timestamp 순서대로 적용. add_player_name이 add_index보다 먼저.
});

// ─────────── (e) edge: 디스크에서 파일이 *사라진* 경우 (사람이 삭제) ───────────

test('(e) 디스크에서 파일 삭제됨 — orphan_in_db는 diff 결과엔 영향 없음 (apply 대상 아님)', () => {
  // diff()는 *disk*만 iterate. DB에만 있고 디스크에 없는 파일은 무시 (재적용 안 됨).
  const disk = [];   // 디스크에서 파일이 사라짐
  const r = diff(disk, ROUND1_APPLIED_MAP);
  assert.equal(r.pending.length, 0);
  assert.equal(r.conflicts.length, 0);
  // → 사람이 reset 없이 파일만 삭제한 케이스. migration agent는 아무것도 안 함.
  //   다음 BE Agent run에서 *applied list*만 prompt에 표시되어 LLM이 인지.
});

// ─────────── D44 통합: db_state.diffApplied도 같은 결론을 내는가? ───────────

test('D44 + D46 통합: db_state.diffApplied가 사용자 보고 사고 (b)를 동일하게 감지', () => {
  // db_state.listAppliedMigrations 형태 (applied_at 포함)
  const applied = [{
    filename: ROUND1_MIGRATION.filename,
    checksum: ROUND1_MIGRATION.checksum,
    applied_at: '2026-05-14T12:00:01Z',
  }];
  // db_state.listDiskMigrations 형태 (size 포함)
  const diskModified = [{
    filename: ROUND1_MIGRATION.filename,
    checksum: 'modified_checksum_xyz',
    size: 200,
  }];

  const r = dbState.diffApplied(applied, diskModified);
  assert.equal(r.in_sync, false, 'checksum 다르면 in_sync=false');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].filename, ROUND1_MIGRATION.filename);
});

test('D44 + D46 통합: 정답 패턴 (새 파일 추가) → orphan_on_disk에 새 파일', () => {
  const applied = [{
    filename: ROUND1_MIGRATION.filename,
    checksum: ROUND1_MIGRATION.checksum,
    applied_at: '2026-05-14T12:00:01Z',
  }];
  const disk = [
    { filename: ROUND1_MIGRATION.filename, checksum: ROUND1_MIGRATION.checksum, size: 200 },
    { filename: '20260514131500_alter.sql', checksum: 'new_checksum', size: 100 },
  ];

  const r = dbState.diffApplied(applied, disk);
  assert.equal(r.conflicts.length, 0, '기존 파일은 그대로 → conflict 0');
  assert.equal(r.orphan_on_disk.length, 1, '새 파일이 orphan_on_disk = 적용 대기');
  assert.equal(r.orphan_on_disk[0], '20260514131500_alter.sql');
});

// ─────────── D46 시나리오와의 정합성: BE retry 시 prompt에 *현재 상태가 정확히 보임* ───────────

test('D46 흐름 검증 (개념): round 2 BE retry 시 prompt에 *round 1 applied list*가 inject됨', () => {
  // D46 (BE 실패 시 FE skip)이 적용되어도 *BE retry 시점*에는 db_state가 정확해야 함.
  // 즉 round 1에서 BE가 migration A 적용 + Lint FAIL → round 2에 BE retry → 그때
  // prompt에 "applied: [A]" 가 들어가야 LLM이 같은 파일 재emit 안 함.

  // 시뮬레이션: round 1 결과
  const round1Applied = [{
    filename: '20260514120000_create_users.sql',
    checksum: 'cs_users',
    applied_at: '2026-05-14T12:00:01Z',
  }];

  // round 2 시작 직전 BE Agent prompt build 시점:
  const promptApplied = dbState.formatApplied(round1Applied);
  assert.match(promptApplied, /20260514120000_create_users\.sql/);
  assert.match(promptApplied, /applied 2026/);

  // 이게 BE Agent buildInitialUserPrompt + buildRetryUserPrompt 둘 다에 들어감.
  // 같은 파일을 다시 emit하지 말라는 *상태 정보* — D44 통합.
});
