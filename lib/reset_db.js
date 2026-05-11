/**
 * Wipe every table in myfirstagentapp_db (FK-safe one-shot).
 * Used as `npm run reset-db`.
 *
 * `log_task_state.decision_id` references `log_agent_decisions(id)`, so a
 * plain TRUNCATE on either table is blocked by the FK constraint. We toggle
 * FOREIGN_KEY_CHECKS off for the call, TRUNCATE all four tables (this also
 * resets AUTO_INCREMENT), then turn checks back on.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'reset.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
    console.log(
      '[reset-db] truncated app_users + log_* in',
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
