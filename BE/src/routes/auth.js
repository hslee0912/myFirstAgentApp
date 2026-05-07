'use strict';

const express = require('express');
const { validateSignupRequest, validateLoginRequest } = require('../middleware/validation');
const { isEmailTaken, createUser, authenticateUser } = require('../services/user_service');

const router = express.Router();

/**
 * POST /api/v1/auth/signup
 * 이메일/비밀번호 회원가입 엔드포인트
 */
router.post('/signup', validateSignupRequest, async (req, res) => {
  try {
    const { email, password } = req.body;

    // 이메일 중복 체크
    const emailExists = await isEmailTaken(email);
    if (emailExists) {
      return res.status(409).json({
        success: false,
        error: 'Email already exists'
      });
    }

    // 사용자 생성
    const user = await createUser(email, password);

    return res.status(201).json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/v1/auth/login
 * 이메일/비밀번호 로그인 엔드포인트
 */
router.post('/login', validateLoginRequest, async (req, res) => {
  try {
    const { email, password } = req.body;

    // 사용자 인증
    const userId = await authenticateUser(email, password);

    if (userId === null) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    return res.status(200).json({
      success: true,
      data: { user_id: userId }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

module.exports = router;
