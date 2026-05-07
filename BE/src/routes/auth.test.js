'use strict';

const request = require('supertest');
const express = require('express');
const authRouter = require('./auth');
const { isEmailTaken, createUser, authenticateUser } = require('../services/user_service');

jest.mock('../services/user_service');

const app = express();
app.use(express.json());
app.use('/api/v1/auth', authRouter);

describe('auth routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/auth/signup', () => {
    test('returns 201 when signup is successful', async () => {
      isEmailTaken.mockResolvedValue(false);
      createUser.mockResolvedValue({
        user_id: 12345,
        email: 'user@example.com',
        created_at: '2025-01-20T10:30:00Z'
      });

      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'user@example.com', password: 'securePassword123' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        data: {
          user_id: 12345,
          email: 'user@example.com',
          created_at: '2025-01-20T10:30:00Z'
        }
      });
      expect(isEmailTaken).toHaveBeenCalledWith('user@example.com');
      expect(createUser).toHaveBeenCalledWith('user@example.com', 'securePassword123');
    });

    test('returns 400 when email is invalid', async () => {
      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'invalid', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toEqual([
        { field: 'email', message: 'Invalid email format or length exceeds 255 characters' }
      ]);
    });

    test('returns 400 when password is too short', async () => {
      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'user@example.com', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toEqual([
        { field: 'password', message: 'Password must be at least 8 characters and at most 128 characters' }
      ]);
    });

    test('returns 409 when email already exists', async () => {
      isEmailTaken.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'existing@example.com', password: 'password123' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        success: false,
        error: 'Email already exists'
      });
      expect(createUser).not.toHaveBeenCalled();
    });

    test('returns 500 when server error occurs', async () => {
      isEmailTaken.mockRejectedValue(new Error('Database error'));

      const res = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: 'user@example.com', password: 'password123' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: 'Internal server error'
      });
    });
  });

  describe('POST /api/v1/auth/login', () => {
    test('returns 200 with user_id when login is successful', async () => {
      authenticateUser.mockResolvedValue(12345);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'SecurePass123!' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { user_id: 12345 }
      });
      expect(authenticateUser).toHaveBeenCalledWith('user@example.com', 'SecurePass123!');
    });

    test('returns 400 when email is invalid', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'invalid-email', password: 'password' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
    });

    test('returns 400 when password is missing', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation failed');
    });

    test('returns 401 when credentials are invalid', async () => {
      authenticateUser.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'wrongPassword' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        success: false,
        error: 'Invalid email or password'
      });
    });

    test('returns 500 when server error occurs', async () => {
      authenticateUser.mockRejectedValue(new Error('Database error'));

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'password' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: 'Internal server error'
      });
    });
  });
});
