/**
 * BE Agent prompt 보강용 — *현재 DB 상태* + *migration 이력* 조회 helper (D44, 2026-05-14).
 *
 * 사용 흐름:
 *   orchestrator Phase 2 — BE Agent 호출 직전 이 모듈로 세 정보 조회 → params에
 *   담아 전달 → be_agent.js의 buildInitialUserPrompt / buildRetryUserPrompt에
 *   inject. LLM이 *이미 적용된 migration이 무엇인지* + *현재 DB schema가 어떻게
 *   생겼는지*를 인지한 상태에서 SQL emit하도록 보강.
 *
 * 왜 필요한가 (D44 결정):
 *   - rules/db.md는 *원칙*(수정 금지, 새 timestamp로 ALTER)을 prompt에 박지만
 *     LLM은 *실제 상태*를 추론할 수 없음 → checksum 충돌 사고 발생.
 *   - D44에서 상태 정보 자체를 prompt에 넣어 사고 차단.
 *
 * 모든 함수는 *읽기 전용*. DB mutation 절대 안 함 (migration_agent.applyOne과
 * 책임 분리).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'BE', 'db', 'migrations');

// ─────────── A: 이미 적용된 migration 이력 ───────────

/**
 * `log_db_migrations`에서 status='SUCCESS' rows 조회.
 *
 * @returns {Promise<Array<{filename:string, checksum:string, applied_at:string, task_id:string}>>}
 *   적용 순서(applied_at ASC)로 정렬.
 */
async function listAppliedMigrations() {
  // log_db_migrations 테이블이 없는 환경(테스트 등)에선 빈 배열 반환.
  try {
    const rows = await db.query(
      "SELECT filename, checksum, applied_at, task_id " +
      "FROM log_db_migrations WHERE status = 'SUCCESS' ORDER BY applied_at ASC"
    );
    return rows.map((r) => ({
      filename: r.filename,
      checksum: r.checksum,
      applied_at: r.applied_at ? new Date(r.applied_at).toISOString() : null,
      task_id: r.task_id,
    }));
  } catch (_) {
    return [];
  }
}

// ─────────── B: 디스크의 migration 파일 list ───────────

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * `BE/db/migrations/*.sql` 디렉터리 ls. 알파벳 순서 (= 시간순).
 *
 * @returns {Array<{filename:string, checksum:string, size:number}>}
 */
function listDiskMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const full = path.join(MIGRATIONS_DIR, filename);
      const content = fs.readFileSync(full, 'utf8');
      return {
        filename,
        checksum: sha256(content),
        size: content.length,
      };
    });
}

/**
 * Applied vs disk consistency 분석. ContractSync처럼 *진단* 정보 전달.
 *
 * @param {Array} applied  - listAppliedMigrations 결과
 * @param {Array} disk     - listDiskMigrations 결과
 * @returns {{
 *   in_sync: boolean,
 *   conflicts: Array<{filename, disk_checksum, applied_checksum}>,
 *   orphan_on_disk: Array<string>,    // 디스크엔 있는데 적용 안 됨
 *   orphan_in_db: Array<string>,      // DB엔 있는데 디스크에서 사라짐
 * }}
 */
function diffApplied(applied, disk) {
  const appliedByFile = new Map(applied.map((a) => [a.filename, a.checksum]));
  const diskByFile = new Map(disk.map((d) => [d.filename, d.checksum]));
  const conflicts = [];
  const orphan_on_disk = [];
  const orphan_in_db = [];
  for (const d of disk) {
    if (!appliedByFile.has(d.filename)) {
      orphan_on_disk.push(d.filename);
    } else if (appliedByFile.get(d.filename) !== d.checksum) {
      conflicts.push({
        filename: d.filename,
        disk_checksum: d.checksum,
        applied_checksum: appliedByFile.get(d.filename),
      });
    }
  }
  for (const a of applied) {
    if (!diskByFile.has(a.filename)) orphan_in_db.push(a.filename);
  }
  return {
    in_sync: conflicts.length === 0 && orphan_on_disk.length === 0 && orphan_in_db.length === 0,
    conflicts,
    orphan_on_disk,
    orphan_in_db,
  };
}

// ─────────── C: 현재 비즈니스 DB schema ───────────

/**
 * `information_schema` 조회로 현재 비즈니스 테이블 컬럼 정보 추출.
 * `log_*` (Agent 도구) 테이블은 *제외* — BE Agent에게 노출할 필요 없음.
 *
 * @returns {Promise<{tables: Object<string, Array<{column, type, nullable, key, default, extra}>>}>}
 */
async function getBusinessDbSchema() {
  try {
    const rows = await db.query(
      "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA " +
      "FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'log\\_%' ESCAPE '\\\\' " +
      "ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
    const tables = {};
    for (const r of rows) {
      const t = r.TABLE_NAME;
      if (!tables[t]) tables[t] = [];
      tables[t].push({
        column: r.COLUMN_NAME,
        type: r.COLUMN_TYPE,
        nullable: r.IS_NULLABLE === 'YES',
        key: r.COLUMN_KEY || '',     // 'PRI', 'UNI', 'MUL', or ''
        default: r.COLUMN_DEFAULT,
        extra: r.EXTRA || '',         // 'auto_increment', 'DEFAULT_GENERATED', etc.
      });
    }
    return { tables };
  } catch (_) {
    return { tables: {} };
  }
}

// ─────────── prompt 표시용 formatters ───────────

/**
 * Applied migrations를 prompt 줄 list로 포맷.
 * @returns {string} "(없음)" 또는 "- <filename>  (applied <ISO>)" 줄들.
 */
function formatApplied(applied) {
  if (!Array.isArray(applied) || applied.length === 0) {
    return '(아직 없음 — 첫 migration cycle)';
  }
  return applied
    .map((a) => `- ${a.filename}  (applied ${a.applied_at || '?'})`)
    .join('\n');
}

/**
 * Disk migration 파일 list 포맷.
 */
function formatDisk(disk) {
  if (!Array.isArray(disk) || disk.length === 0) {
    return '(없음)';
  }
  return disk.map((d) => `- BE/db/migrations/${d.filename}`).join('\n');
}

/**
 * 비즈니스 DB schema 한 줄/테이블 포맷.
 * users(id INT PRI auto_increment, email VARCHAR(255) UNI NOT NULL, ...)
 */
function formatSchema(schemaObj) {
  if (!schemaObj || !schemaObj.tables || Object.keys(schemaObj.tables).length === 0) {
    return '(아직 비즈니스 테이블 없음 — 이번 cycle에 CREATE TABLE 가능)';
  }
  const lines = [];
  for (const [name, cols] of Object.entries(schemaObj.tables)) {
    const colSpecs = cols.map((c) => {
      const parts = [c.column, c.type];
      if (c.key === 'PRI') parts.push('PRI');
      else if (c.key === 'UNI') parts.push('UNI');
      else if (c.key === 'MUL') parts.push('IDX');
      if (!c.nullable) parts.push('NOT NULL');
      if (c.extra) parts.push(c.extra);
      return parts.join(' ');
    });
    lines.push(`- ${name}(${colSpecs.join(', ')})`);
  }
  return lines.join('\n');
}

// ─────────── 통합 entry: BE Agent용 stateBundle ───────────

/**
 * BE Agent 호출 직전에 부르는 통합 entry. 세 정보 한 번에 조회.
 * 실패해도 throw 안 함 — 각 영역이 빈 결과를 가질 수 있음 (테스트 환경 등).
 *
 * @returns {Promise<{
 *   applied: Array,
 *   disk: Array,
 *   diff: Object,
 *   schema: Object,
 * }>}
 */
async function getBeStateBundle() {
  const [applied, schema] = await Promise.all([
    listAppliedMigrations(),
    getBusinessDbSchema(),
  ]);
  const disk = listDiskMigrations();   // sync
  return {
    applied,
    disk,
    diff: diffApplied(applied, disk),
    schema,
  };
}

module.exports = {
  // raw fetchers
  listAppliedMigrations,
  listDiskMigrations,
  getBusinessDbSchema,
  // diff
  diffApplied,
  // formatters
  formatApplied,
  formatDisk,
  formatSchema,
  // composed entry
  getBeStateBundle,
  // exposed for unit tests
  _internal: { sha256, MIGRATIONS_DIR },
};
