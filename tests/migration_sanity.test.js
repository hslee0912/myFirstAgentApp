/**
 * Unit tests for lib/migration_sanity.js (D48, 2026-05-14).
 *
 * 사용자 보고 사고 (big-cycle 4 ERROR) 정확 재현 + 다른 antipattern 변형 검증.
 * tmp 디렉터리에 fake BE/db/migrations/*.sql 깐 뒤 checkMigrationSanity 호출.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkMigrationSanity } = require('../lib/migration_sanity');

// ─────────── tmp helpers ───────────

function mkMigrationsDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msanity-'));
  const dir = path.join(root, 'BE', 'db', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true }); } catch (_) {}
}

// ─────────── 정상 case ───────────

test('정상: 인덱스를 CREATE TABLE 정의 안에 넣음 (rules/db.md 권장 패턴)', () => {
  const dir = mkMigrationsDir({
    '20260514120000_create_users.sql': `
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        INDEX idx_email (email)
      );
    `,
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, true);
    assert.deepEqual(r.violations, []);
  } finally { cleanup(dir); }
});

test('정상: ALTER TABLE ADD INDEX (별도 migration 파일)', () => {
  const dir = mkMigrationsDir({
    '20260514130000_add_index.sql': `
      ALTER TABLE users ADD INDEX idx_player_name (player_name);
    `,
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, true);
  } finally { cleanup(dir); }
});

test('정상: 디렉터리 없으면 skipped=no_dir, pass=true', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msanity-empty-'));
  try {
    const r = checkMigrationSanity(path.join(root, 'nope'));
    assert.equal(r.pass, true);
    assert.equal(r.skipped, 'no_dir');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
});

test('정상: 디렉터리 있지만 .sql 0개 → skipped=no_files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msanity-empty-dir-'));
  const dir = path.join(root, 'BE', 'db', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'not sql');
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, true);
    assert.equal(r.skipped, 'no_files');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
});

// ─────────── ① CREATE INDEX IF NOT EXISTS (사용자 보고 사고 정확 재현) ───────────

test('★ ① CREATE INDEX IF NOT EXISTS — MySQL 미지원 (big-cycle 4 사고 정확 재현)', () => {
  const dir = mkMigrationsDir({
    '20260514120100_create_game_results.sql': `
      CREATE TABLE IF NOT EXISTS game_results (
        id INT AUTO_INCREMENT PRIMARY KEY,
        player_id INT NOT NULL,
        score INT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_player_score ON game_results(player_id, score DESC);
    `,
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].rule, 'CREATE_INDEX_IF_NOT_EXISTS_MYSQL_UNSUPPORTED');
    assert.match(r.violations[0].file, /20260514120100_create_game_results\.sql/);
    assert.match(r.violations[0].snippet, /CREATE INDEX IF NOT EXISTS idx_player_score/);
    // fix_instructions에 정확한 안내 + 룰 참조
    assert.match(r.fix_instructions, /LINT STAGE1 \/ migration_sanity/);
    assert.match(r.fix_instructions, /rules\/db\.md §4-bis/);
  } finally { cleanup(dir); }
});

test('① UNIQUE INDEX IF NOT EXISTS도 잡힘', () => {
  const dir = mkMigrationsDir({
    'm.sql': 'CREATE UNIQUE INDEX IF NOT EXISTS u_email ON users(email);',
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations[0].rule, 'CREATE_INDEX_IF_NOT_EXISTS_MYSQL_UNSUPPORTED');
  } finally { cleanup(dir); }
});

test('① FULLTEXT INDEX IF NOT EXISTS도 잡힘', () => {
  const dir = mkMigrationsDir({
    'm.sql': 'CREATE FULLTEXT INDEX IF NOT EXISTS ft_body ON posts(body);',
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations[0].rule, 'CREATE_INDEX_IF_NOT_EXISTS_MYSQL_UNSUPPORTED');
  } finally { cleanup(dir); }
});

test('① 대소문자 혼합 (Create Index If Not Exists) 도 잡힘', () => {
  const dir = mkMigrationsDir({
    'm.sql': 'Create Index If Not Exists idx_x ON t(x);',
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, false);
  } finally { cleanup(dir); }
});

test('① 주석 안의 패턴은 false positive 아님 (line comment + block comment 둘 다)', () => {
  const dir = mkMigrationsDir({
    'm.sql': `
      -- CREATE INDEX IF NOT EXISTS idx_x ON t(x);     (이건 주석)
      /* CREATE INDEX IF NOT EXISTS idx_y ON t(y); */
      CREATE INDEX idx_real ON t(z);
    `,
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, true);  // 주석 안은 무시
  } finally { cleanup(dir); }
});

test('① CREATE INDEX (IF NOT EXISTS 없음)는 OK', () => {
  const dir = mkMigrationsDir({
    'm.sql': 'CREATE INDEX idx_email ON users(email);',
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, true);
  } finally { cleanup(dir); }
});

// ─────────── 여러 파일에 분산된 위반 ───────────

test('여러 파일에 위반 — 모두 보고', () => {
  const dir = mkMigrationsDir({
    '20260514120000_a.sql': 'CREATE INDEX IF NOT EXISTS idx_a ON t(a);',
    '20260514120100_b.sql': 'CREATE INDEX IF NOT EXISTS idx_b ON t(b);',
    '20260514120200_c.sql': 'CREATE TABLE c (id INT);',   // 정상
  });
  try {
    const r = checkMigrationSanity(dir);
    assert.equal(r.pass, false);
    assert.equal(r.violations.length, 2);
    assert.match(r.violations[0].file, /a\.sql/);
    assert.match(r.violations[1].file, /b\.sql/);
  } finally { cleanup(dir); }
});

// ─────────── rules/db.md §4-bis 정합성 ───────────

test('rules/db.md §4-bis 에 인덱스 안내 + 정확한 antipattern 명시', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'db.md'), 'utf8');
  assert.match(md, /4-bis/);
  assert.match(md, /CREATE INDEX/);
  assert.match(md, /IF NOT EXISTS/);
  assert.match(md, /MySQL.*지원하지 않습니다|미지원/);
  // 정답 패턴도 명시
  assert.match(md, /CREATE TABLE.*INDEX/);
  assert.match(md, /ALTER TABLE.*ADD INDEX/);
});
