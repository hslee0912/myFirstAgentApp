/**
 * Run db/schema.sql against the configured MySQL instance.
 * Used as `npm run init-db`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
    console.log('[init-db] schema applied to', process.env.DB_NAME || 'myfirstagentapp_db');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[init-db] failed:', e.message);
  process.exit(1);
});
