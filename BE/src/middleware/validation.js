'use strict';

/**
 * 이메일 형식을 검증한다.
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return typeof email === 'string' && email.length <= 255 && emailRegex.test(email);
}

/**
 * 비밀번호 길이를 검증한다 (회원가입용).
 * @param {string} password
 * @returns {boolean}
 */
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

/**
 * 로그인용 비밀번호 존재 여부만 검증한다.
 * @param {string} password
 * @returns {boolean}
 */
function isValidLoginPassword(password) {
  return typeof password === 'string' && password.length >= 1;
}

/**
 * 회원가입 요청 바디를 검증하는 미들웨어
 */
function validateSignupRequest(req, res, next) {
  const { email, password } = req.body;
  const errors = [];

  if (!email) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!isValidEmail(email)) {
    errors.push({ field: 'email', message: 'Invalid email format or length exceeds 255 characters' });
  }

  if (!password) {
    errors.push({ field: 'password', message: 'Password is required' });
  } else if (!isValidPassword(password)) {
    errors.push({ field: 'password', message: 'Password must be at least 8 characters and at most 128 characters' });
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors
    });
  }

  next();
}

/**
 * 로그인 요청 바디를 검증하는 미들웨어
 */
function validateLoginRequest(req, res, next) {
  const { email, password } = req.body;
  const errors = [];

  if (!email) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!isValidEmail(email)) {
    errors.push({ field: 'email', message: 'Invalid email format or length exceeds 255 characters' });
  }

  if (!password) {
    errors.push({ field: 'password', message: 'Password is required' });
  } else if (!isValidLoginPassword(password)) {
    errors.push({ field: 'password', message: 'Password must be at least 1 character' });
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors
    });
  }

  next();
}

module.exports = { validateSignupRequest, validateLoginRequest, isValidEmail, isValidPassword, isValidLoginPassword };
