/**
 * MySQL connection pool (single DB: myfirstagentapp_db)
 * Used by all agents + orchestrator for log_* tables and by BE runtime for app_users.
 */
'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config({ override: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'myfirstagentapp_db',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, close };
