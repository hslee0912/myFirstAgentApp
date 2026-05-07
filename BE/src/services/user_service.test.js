'use strict';

const bcrypt = require('bcrypt');
const { isEmailTaken, createUser } = require('./user_service');
const { getPool, closePool } = require('../db/connection');

jest.mock('../db/connection');

describe('user_service', () => {
  let mockPool;

  beforeEach(() => {
    mockPool = {
      query: jest.fn()
    };
    getPool.mockReturnValue(mockPool);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('isEmailTaken', () => {
    test('returns true when email exists', async () => {
      mockPool.query.mockResolvedValue([[{ count: 1 }]]);
      const result = await isEmailTaken('test@example.com');
      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM app_users WHERE email = ? LIMIT 1',
        ['test@example.com']
      );
    });

    test('returns false when email does not exist', async () => {
      mockPool.query.mockResolvedValue([[{ count: 0 }]]);
      const result = await isEmailTaken('new@example.com');
      expect(result).toBe(false);
    });

    test('normalizes email to lowercase', async () => {
      mockPool.query.mockResolvedValue([[{ count: 0 }]]);
      await isEmailTaken('Test@Example.COM');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['test@example.com']
      );
    });
  });

  describe('createUser', () => {
    test('creates user with hashed password', async () => {
      const now = new Date();
      mockPool.query
        .mockResolvedValueOnce([{ insertId: 123 }])
        .mockResolvedValueOnce([[{ id: 123, email: 'user@example.com', created_at: now }]]);

      const result = await createUser('user@example.com', 'password123');

      expect(result).toEqual({
        user_id: 123,
        email: 'user@example.com',
        created_at: now.toISOString()
      });
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      const insertCall = mockPool.query.mock.calls[0];
      expect(insertCall[0]).toBe('INSERT INTO app_users (email, password_hash) VALUES (?, ?)');
      expect(insertCall[1][0]).toBe('user@example.com');
      expect(typeof insertCall[1][1]).toBe('string');
      expect(insertCall[1][1].length).toBeGreaterThan(20);
    });

    test('normalizes email to lowercase before storing', async () => {
      const now = new Date();
      mockPool.query
        .mockResolvedValueOnce([{ insertId: 456 }])
        .mockResolvedValueOnce([[{ id: 456, email: 'upper@example.com', created_at: now }]]);

      await createUser('UPPER@Example.COM', 'pass');

      const insertCall = mockPool.query.mock.calls[0];
      expect(insertCall[1][0]).toBe('upper@example.com');
    });
  });
});
