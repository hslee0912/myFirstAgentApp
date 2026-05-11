'use strict';

const express = require('express');
const authService = require('../services/auth_service');

const router = express.Router();

router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: '이메일과 비밀번호는 필수입니다'
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        error: '이메일 형식이 유효하지 않습니다'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: '비밀번호는 8자 이상이어야 합니다'
      });
    }

    const result = await authService.signup(email, password);

    if (!result.success) {
      if (result.error === 'EMAIL_EXISTS') {
        return res.status(409).json({
          success: false,
          error: '이미 가입된 이메일입니다'
        });
      }
      return res.status(500).json({
        success: false,
        error: '회원가입 처리 중 오류가 발생했습니다'
      });
    }

    res.status(201).json({
      success: true,
      data: result.data
    });
  } catch (error) {
    console.error('Signup route error:', error);
    res.status(500).json({
      success: false,
      error: '서버 오류가 발생했습니다'
    });
  }
});

module.exports = router;
