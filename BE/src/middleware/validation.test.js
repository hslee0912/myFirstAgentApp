'use strict';

const { isValidEmail, isValidPassword, validateSignupRequest } = require('./validation');

describe('validation', () => {
  describe('isValidEmail', () => {
    test('returns true for valid email', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name+tag@example.co.uk')).toBe(true);
    });

    test('returns false for invalid email', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('missing@domain')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
      expect(isValidEmail('a'.repeat(256) + '@example.com')).toBe(false);
    });

    test('returns false for non-string input', () => {
      expect(isValidEmail(null)).toBe(false);
      expect(isValidEmail(undefined)).toBe(false);
      expect(isValidEmail(123)).toBe(false);
    });
  });

  describe('isValidPassword', () => {
    test('returns true for valid password', () => {
      expect(isValidPassword('12345678')).toBe(true);
      expect(isValidPassword('a'.repeat(128))).toBe(true);
    });

    test('returns false for password too short', () => {
      expect(isValidPassword('short')).toBe(false);
      expect(isValidPassword('1234567')).toBe(false);
    });

    test('returns false for password too long', () => {
      expect(isValidPassword('a'.repeat(129))).toBe(false);
    });

    test('returns false for non-string input', () => {
      expect(isValidPassword(null)).toBe(false);
      expect(isValidPassword(undefined)).toBe(false);
      expect(isValidPassword(12345678)).toBe(false);
    });
  });

  describe('validateSignupRequest', () => {
    let req, res, next;

    beforeEach(() => {
      req = { body: {} };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      next = jest.fn();
    });

    test('calls next() for valid request', () => {
      req.body = { email: 'test@example.com', password: 'password123' };
      validateSignupRequest(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('returns 400 when email is missing', () => {
      req.body = { password: 'password123' };
      validateSignupRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Validation failed',
        details: [{ field: 'email', message: 'Email is required' }]
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 400 when email is invalid', () => {
      req.body = { email: 'invalid-email', password: 'password123' };
      validateSignupRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].details[0].field).toBe('email');
    });

    test('returns 400 when password is missing', () => {
      req.body = { email: 'test@example.com' };
      validateSignupRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Validation failed',
        details: [{ field: 'password', message: 'Password is required' }]
      });
    });

    test('returns 400 when password is too short', () => {
      req.body = { email: 'test@example.com', password: 'short' };
      validateSignupRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].details[0].field).toBe('password');
    });

    test('returns 400 with multiple errors', () => {
      req.body = {};
      validateSignupRequest(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].details).toHaveLength(2);
    });
  });
});
