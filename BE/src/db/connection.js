'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

let pool;

/**
 * MySQL 커넥션 풀을 생성하고 반환한다.
 * @returns {Promise<mysql.Pool>}
 */
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'myapp',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  }
  return pool;
}

/**
 * 커넥션 풀을 종료한다.
 * @returns {Promise<void>}
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, closePool };
