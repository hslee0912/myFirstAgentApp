/**
 * Migration Agent (D33, 2026-05-14, Phase 2.5).
 *
 * 책임: BE Agent가 emit한 `BE/db/migrations/<timestamp>_<name>.sql` 파일을
 * MySQL에 적용 + 이력 테이블(`log_db_migrations`)에 기록.
 *
 * 결정론 영역 (LLM 호출 X). orchestrator가 BE Agent 직후 Lint 직전 호출.
 *
 * 흐름:
 *   1. `BE/db/migrations/` 디렉터리 스캔 → *.sql 파일 (알파벳/timestamp 순)
 *   2. `log_db_migrations`에서 적용 이력 조회
 *   3. 비교:
 *      - 디스크에 있는데 이력 없음 → pending (apply)
 *      - 이력 있는데 disk checksum != DB checksum → conflict (fail)
 *      - 둘 다 있고 checksum 일치 → skip
 *   4. pending 파일 순서대로 mysql.query → 성공/실패 별 이력 row INSERT
 *   5. 결과 객체 반환 (status, applied[], failed?, error?, fix_instructions?)
 *
 * Idempotency: 같은 migration 파일은 한 번만 적용. retry 안전.
 * Atomicity: 각 migration은 *그 자체로 atomic*하게 작성될 책임 (LLM이 보장).
 *   migration 단위 transaction은 안 씀 — DDL이 MySQL에서 implicit commit이라
 *   transaction이 의미 없음.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

const logger = require('../lib/logger');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'BE', 'db', 'migrations');

/**
 * 파일 내용의 SHA-256 hex digest. `log_db_migrations.checksum`(CHAR(64))과 일치.
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 디스크의 migration 파일 목록 + 각 파일의 checksum.
 * 알파벳 순서로 정렬 (timestamp prefix 컨벤션 가정).
 *
 * @returns {Array<{filename:string, content:string, checksum:string}>}
 */
function listDiskMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, content, checksum: sha256(content) };
    });
}

/**
 * DB의 적용 이력 조회. status='SUCCESS' 인 것만 (실패 row는 재시도 가능).
 *
 * @param {mysql.Connection} conn
 * @returns {Promise<Map<string, string>>}  filename → checksum
 */
async function listAppliedMigrations(conn) {
  const [rows] = await conn.query(
    'SELECT filename, checksum FROM log_db_migrations WHERE status = ?',
    ['SUCCESS']
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

/**
 * 디스크 vs DB 비교해 *적용 대상*과 *충돌* 분리.
 *
 * @returns {{pending: Array, conflicts: Array}}
 */
function diff(diskList, appliedMap) {
  const pending = [];
  const conflicts = [];
  for (const m of diskList) {
    if (!appliedMap.has(m.filename)) {
      pending.push(m);
    } else if (appliedMap.get(m.filename) !== m.checksum) {
      conflicts.push({
        filename: m.filename,
        disk_checksum: m.checksum,
        applied_checksum: appliedMap.get(m.filename),
      });
    }
    // else: 이미 적용됨 + checksum 일치 → skip
  }
  return { pending, conflicts };
}

/**
 * 단일 migration 적용. 성공/실패 둘 다 `log_db_migrations`에 row INSERT.
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function applyOne(conn, m, task_id) {
  try {
    // multipleStatements: true 옵션이 connection에 설정되어 있어야 multi-statement OK.
    await conn.query(m.content);
    await conn.query(
      'INSERT INTO log_db_migrations (filename, task_id, checksum, status) VALUES (?, ?, ?, ?)',
      [m.filename, task_id, m.checksum, 'SUCCESS']
    );
    return { ok: true };
  } catch (e) {
    const errMsg = String(e.message || e).slice(0, 2000);
    // 실패 row도 기록 — 운영 추적용. UNIQUE(filename) 충돌 가능성 있으니 try.
    try {
      await conn.query(
        'INSERT INTO log_db_migrations (filename, task_id, checksum, status, error_message) VALUES (?, ?, ?, ?, ?)',
        [m.filename, task_id, m.checksum, 'FAILED', errMsg]
      );
    } catch (_) { /* UNIQUE 충돌이면 무시 — 이전에 FAILED row가 이미 있는 경우 */ }
    return { ok: false, error: errMsg };
  }
}

/**
 * Phase 2.5 entry — orchestrator가 BE Agent 직후 호출.
 *
 * @param {{task_id: string}} params
 * @returns {Promise<{
 *   status: 'SUCCESS'|'FAILED',
 *   applied: string[],
 *   skipped?: number,
 *   conflicts?: Array,
 *   failed?: string,
 *   error?: string,
 *   fix_instructions?: string
 * }>}
 */
async function run({ task_id }) {
  const run_id = await logger.startRun({
    task_id,
    agent_name: 'Migration',
    target: 'BE',
    input_json: { migrations_dir: 'BE/db/migrations' },
  });

  const result = { status: 'SUCCESS', applied: [], skipped: 0 };
  let conn = null;
  try {
    const diskList = listDiskMigrations();
    if (diskList.length === 0) {
      result.skipped = 0;
      result.notice = 'no migrations directory or empty';
      await logger.endRun(run_id, { status: 'SUCCESS', output_json: result });
      return result;
    }

    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'myfirstagentapp_db',
      multipleStatements: true,
    });

    const appliedMap = await listAppliedMigrations(conn);
    const { pending, conflicts } = diff(diskList, appliedMap);
    result.skipped = diskList.length - pending.length - conflicts.length;

    if (conflicts.length > 0) {
      // 이미 적용된 migration 파일이 *내용 변경*됨 → 안전상 즉시 FAIL.
      result.status = 'FAILED';
      result.conflicts = conflicts;
      result.error = `이미 적용된 migration이 변경됨 (checksum mismatch): ${conflicts.map((c) => c.filename).join(', ')}`;
      result.fix_instructions =
        `[Migration] ${conflicts.map((c) => c.filename).join(', ')} 파일이 적용 후 변경됨. ` +
        `규칙: 적용된 migration은 *수정 금지*. 변경이 필요하면 *새 timestamp의 새 파일*로 ALTER/추가 migration을 만들 것.`;
      await logger.endRun(run_id, { status: 'FAILED', output_json: result });
      return result;
    }

    // pending 순서대로 적용 — 한 개라도 실패하면 즉시 중단
    for (const m of pending) {
      const r = await applyOne(conn, m, task_id);
      if (!r.ok) {
        result.status = 'FAILED';
        result.failed = m.filename;
        result.error = r.error;
        result.fix_instructions =
          `[Migration] BE/db/migrations/${m.filename} 적용 실패: ${r.error}. ` +
          `흔한 원인: SQL 문법 / 기존 schema와의 FK·UNIQUE 충돌 / 이미 존재하는 테이블·컬럼 (IF NOT EXISTS 누락) / ` +
          `이전 migration의 결과에 대한 잘못된 가정. SQL 수정 또는 새 migration 파일로 보정.`;
        await logger.endRun(run_id, { status: 'FAILED', output_json: result });
        return result;
      }
      result.applied.push(m.filename);
    }

    await logger.endRun(run_id, { status: 'SUCCESS', output_json: result });
    return result;
  } catch (e) {
    result.status = 'FAILED';
    result.error = String(e.message || e);
    result.fix_instructions = `[Migration] 예외: ${result.error}`;
    await logger.endRun(run_id, { status: 'FAILED', output_json: result });
    return result;
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  run,
  // 단위 테스트용 헬퍼 export
  _internal: { sha256, listDiskMigrations, listAppliedMigrations, diff, applyOne, MIGRATIONS_DIR },
};
