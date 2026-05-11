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
          userId: 'uuid-1234',
          email: 'test@example.com'
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
      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/signup', {
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
        error: '이미 가입된 이메일입니다'
      };

      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => mockResponse
      });

      const result = await signup({
        email: 'existing@example.com',
        password: 'password123'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('이미 가입된 이메일입니다');
    });

    it('returns error response on validation failure', async () => {
      const mockResponse = {
        success: false,
        error: '비밀번호는 8자 이상이어야 합니다'
      };

      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => mockResponse
      });

      const result = await signup({
        email: 'test@example.com',
        password: 'short'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('비밀번호는 8자 이상이어야 합니다');
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
