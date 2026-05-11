'use strict';

const bcrypt = require('bcrypt');
const db = require('../lib/db');

/**
 * 이메일 중복 체크
 * @param {string} email
 * @returns {Promise<boolean>} 이미 존재하면 true
 */
async function isEmailTaken(email) {
  const [rows] = await db.execute(
    'SELECT id FROM app_users WHERE email = ? LIMIT 1',
    [email]
  );
  return rows.length > 0;
}

/**
 * 회원가입 처리
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
async function signup(email, password) {
  try {
    const exists = await isEmailTaken(email);
    if (exists) {
      return { success: false, error: 'EMAIL_ALREADY_EXISTS' };
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await db.execute(
      'INSERT INTO app_users (email, password_hash) VALUES (?, ?)',
      [email, passwordHash]
    );

    const userId = result.insertId;

    const [userRows] = await db.execute(
      'SELECT id, email, created_at FROM app_users WHERE id = ?',
      [userId]
    );

    const user = userRows[0];

    return {
      success: true,
      data: {
        id: user.id,
        email: user.email,
        created_at: user.created_at
      }
    };
  } catch (err) {
    console.error('signup error:', err);
    return { success: false, error: 'INTERNAL_SERVER_ERROR' };
  }
}

module.exports = {
  signup,
  isEmailTaken
};
