/**
 * Reset every Agent 도구 테이블 in myfirstagentapp_db.
 * Used as `npm run reset-db`.
 *
 * 흐름 (D31=a, 2026-05-13):
 *   1. db/reset.sql 실행  → DROP TABLE log_* (FK 의존 순서)
 *   2. db/agent_schema.sql 실행 → 모든 테이블 fresh CREATE
 * "재실행" 시맨틱 그대로 — 컬럼 추가 등 schema 변경도 reset 한 번으로 반영.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function main() {
  const resetSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'reset.sql'), 'utf8');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'agent_schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  try {
    await conn.query(resetSql);
    await conn.query(schemaSql);
    console.log(
      '[reset-db] dropped + recreated log_* in',
      process.env.DB_NAME || 'myfirstagentapp_db'
    );
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[reset-db] failed:', e.message);
  process.exit(1);
});
