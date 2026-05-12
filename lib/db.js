/**
 * MySQL connection pool (single DB: myfirstagentapp_db)
 * Used by all agents + orchestrator for log_* (Agent 도구) tables.
 * 비즈니스 schema (app_users 등)는 D31(2026-05-13)로 폐기됨 — agent_schema.sql 참조.
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
