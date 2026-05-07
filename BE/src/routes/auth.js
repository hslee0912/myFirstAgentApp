'use strict';

const express = require('express');
const { validateSignupRequest } = require('../middleware/validation');
const { isEmailTaken, createUser } = require('../services/user_service');

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

module.exports = router;
