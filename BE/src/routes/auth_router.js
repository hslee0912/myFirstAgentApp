'use strict';

const express = require('express');
const authService = require('../services/auth_service');

const router = express.Router();

/**
 * POST /api/v1/auth/signup
 * 회원가입 엔드포인트
 */
router.post('/signup', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'INVALID_EMAIL' });
    }

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'PASSWORD_TOO_SHORT' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'INVALID_EMAIL' });
    }

    if (email.length > 255) {
      return res.status(400).json({ success: false, error: 'INVALID_EMAIL' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'PASSWORD_TOO_SHORT' });
    }

    const result = await authService.signup(email, password);

    if (!result.success) {
      if (result.error === 'EMAIL_ALREADY_EXISTS') {
        return res.status(409).json({ success: false, error: result.error });
      }
      return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' });
    }

    return res.status(201).json({
      success: true,
      data: {
        id: result.data.id,
        email: result.data.email,
        created_at: result.data.created_at
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
