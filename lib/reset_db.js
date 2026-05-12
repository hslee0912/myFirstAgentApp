/**
 * Reset DB. myfirstagentapp_db의 *모든* 테이블 DROP → db/*.sql 순회 실행.
 * Used as `npm run reset-db`.
 *
 * 흐름 (D32, 2026-05-14):
 *   1. db/reset.sql 실행  → information_schema 기반 모든 테이블 동적 DROP
 *   2. db/*.sql 알파벳 순서로 실행 (reset.sql 자기 자신은 제외)
 *      - 현재: agent_schema.sql만 존재
 *      - 미래: db/business_schema.sql 등이 추가되면 자동 함께 적용
 *
 * 이전 (D31=a) 흐름과의 차이:
 *   - DROP 대상이 *log_* 명시 목록* → *모든 테이블*. agent 외 schema가 끼면
 *     그것도 함께 정리됨 (사용자 의도: "myfirstagentapp_db 안의 모든 테이블 삭제").
 *   - 두 번째 step도 *agent_schema.sql 하드코딩* → *db/*.sql 순회*. 새 schema
 *     파일 추가 시 코드 변경 없이 자동 적용.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

const DB_DIR = path.join(__dirname, '..', 'db');

/** db/ 안의 *.sql 중 reset.sql을 제외하고 알파벳 순서로 반환. */
function listSchemaFiles() {
  return fs.readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql') && f !== 'reset.sql')
    .sort();
}

async function main() {
  const resetSql = fs.readFileSync(path.join(DB_DIR, 'reset.sql'), 'utf8');
  const schemaFiles = listSchemaFiles();

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  try {
    // 1) 모든 테이블 동적 DROP
    await conn.query(resetSql);
    // 2) db/*.sql 알파벳 순서로 실행
    for (const f of schemaFiles) {
      await conn.query(fs.readFileSync(path.join(DB_DIR, f), 'utf8'));
    }
    console.log(
      `[reset-db] dropped all + applied ${schemaFiles.length} schema file(s)` +
        (schemaFiles.length > 0 ? ` (${schemaFiles.join(', ')})` : '') +
        ` in ${process.env.DB_NAME || 'myfirstagentapp_db'}`
    );
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[reset-db] failed:', e.message);
  process.exit(1);
});
