import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signup, login } from './auth.js';

describe('auth API', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('signup', () => {
    it('returns success response on successful signup', async () => {
      const mockResponse = {
        success: true,
        data: {
          user_id: 12345,
          email: 'test@example.com',
          created_at: '2025-01-20T10:30:00Z'
        }
      };

      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const result = await signup({
        email: 'test@example.com',
        password: 'password123'
      });

      expect(result).toEqual(mockResponse);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });
    });

    it('returns error response on duplicate email', async () => {
      const mockResponse = {
        success: false,
        error: 'Email already exists'
      };

      globalThis.fetch.mockResolvedValue({
        ok: false,
        json: async () => mockResponse
      });

      const result = await signup({
        email: 'existing@example.com',
        password: 'password123'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Email already exists');
    });

    it('returns error response on validation failure', async () => {
      const mockResponse = {
        success: false,
        error: 'Validation failed',
        details: [
          {
            field: 'password',
            message: 'Password must be at least 8 characters'
          }
        ]
      };

      globalThis.fetch.mockResolvedValue({
        ok: false,
        json: async () => mockResponse
      });

      const result = await signup({
        email: 'test@example.com',
        password: 'short'
      });

      expect(result.success).toBe(false);
      expect(result.details).toBeDefined();
      expect(result.details[0].field).toBe('password');
    });

    it('handles network errors gracefully', async () => {
      globalThis.fetch.mockRejectedValue(new Error('Network error'));

      const result = await signup({
        email: 'test@example.com',
        password: 'password123'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('login', () => {
    it('returns success response on successful login', async () => {
      const mockResponse = {
        success: true,
        data: { user_id: 12345 }
      };

      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      });

      const result = await login({
        email: 'test@example.com',
        password: 'password123'
      });

      expect(result).toEqual(mockResponse);
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });
    });

    it('returns error response on invalid credentials', async () => {
      const mockResponse = {
        success: false,
        error: 'Invalid email or password'
      };

      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => mockResponse
      });

      const result = await login({
        email: 'wrong@example.com',
        password: 'wrongpass'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email or password');
    });

    it('returns error response on validation failure', async () => {
      const mockResponse = {
        success: false,
        error: 'Invalid email format'
      };

      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => mockResponse
      });

      const result = await login({
        email: 'invalid-email',
        password: 'password123'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
    });

    it('handles network errors gracefully', async () => {
      globalThis.fetch.mockRejectedValue(new Error('Network error'));

      const result = await login({
        email: 'test@example.com',
        password: 'password123'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });
});
