'use strict';

const bcrypt = require('bcrypt');
const db = require('../db');

const SALT_ROUNDS = 10;

async function signup(email, password) {
  try {
    const [rows] = await db.execute(
      'SELECT COUNT(*) as count FROM app_users WHERE email = ?',
      [email]
    );

    if (rows[0].count > 0) {
      return {
        success: false,
        error: 'EMAIL_EXISTS'
      };
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await db.execute(
      'INSERT INTO app_users (email, password_hash) VALUES (?, ?)',
      [email, passwordHash]
    );

    const [userRows] = await db.execute(
      'SELECT id, email, created_at FROM app_users WHERE id = ?',
      [result.insertId]
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
  } catch (error) {
    console.error('Signup service error:', error);
    return {
      success: false,
      error: 'DB_ERROR'
    };
  }
}

module.exports = {
  signup
};
