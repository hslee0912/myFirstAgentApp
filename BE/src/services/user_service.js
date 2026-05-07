'use strict';

const bcrypt = require('bcrypt');
const { getPool } = require('../db/connection');

const SALT_ROUNDS = 10;

/**
 * 이메일 중복을 확인한다.
 * @param {string} email
 * @returns {Promise<boolean>} 이미 가입된 이메일이면 true
 */
async function isEmailTaken(email) {
  const pool = getPool();
  const normalizedEmail = email.toLowerCase();
  const [rows] = await pool.query(
    'SELECT COUNT(*) as count FROM app_users WHERE email = ? LIMIT 1',
    [normalizedEmail]
  );
  return rows[0].count > 0;
}

/**
 * 새 사용자를 생성한다.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} { user_id, email, created_at }
 */
async function createUser(email, password) {
  const pool = getPool();
  const normalizedEmail = email.toLowerCase();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const [result] = await pool.query(
    'INSERT INTO app_users (email, password_hash) VALUES (?, ?)',
    [normalizedEmail, passwordHash]
  );

  const userId = result.insertId;

  const [rows] = await pool.query(
    'SELECT id, email, created_at FROM app_users WHERE id = ?',
    [userId]
  );

  const user = rows[0];
  return {
    user_id: user.id,
    email: user.email,
    created_at: user.created_at.toISOString()
  };
}

/**
 * 이메일과 비밀번호로 사용자를 인증한다.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<number|null>} 인증 성공 시 user_id, 실패 시 null
 */
async function authenticateUser(email, password) {
  const pool = getPool();
  const normalizedEmail = email.toLowerCase();

  const [rows] = await pool.query(
    'SELECT id, password_hash FROM app_users WHERE email = ? LIMIT 1',
    [normalizedEmail]
  );

  if (rows.length === 0) {
    return null;
  }

  const user = rows[0];
  const isPasswordValid = await bcrypt.compare(password, user.password_hash);

  if (!isPasswordValid) {
    return null;
  }

  return user.id;
}

module.exports = { isEmailTaken, createUser, authenticateUser };
