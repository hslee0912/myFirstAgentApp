import { describe, it, expect } from 'vitest';
import { validateEmail, validatePassword, validatePasswordMatch } from './validation.js';

describe('validation utils', () => {
  describe('validateEmail', () => {
    it('returns empty string for valid email', () => {
      expect(validateEmail('test@example.com')).toBe('');
      expect(validateEmail('user.name+tag@domain.co.uk')).toBe('');
    });

    it('returns error message for invalid email', () => {
      expect(validateEmail('invalid-email')).toBe('올바른 이메일 형식을 입력하세요');
      expect(validateEmail('test@')).toBe('올바른 이메일 형식을 입력하세요');
      expect(validateEmail('@example.com')).toBe('올바른 이메일 형식을 입력하세요');
    });

    it('returns error message for empty email', () => {
      expect(validateEmail('')).toBe('이메일을 입력하세요');
    });
  });

  describe('validatePassword', () => {
    it('returns empty string for valid password', () => {
      expect(validatePassword('password123')).toBe('');
      expect(validatePassword('12345678')).toBe('');
    });

    it('returns error message for short password', () => {
      expect(validatePassword('short')).toBe('비밀번호는 8자 이상이어야 합니다');
      expect(validatePassword('1234567')).toBe('비밀번호는 8자 이상이어야 합니다');
    });

    it('returns error message for empty password', () => {
      expect(validatePassword('')).toBe('비밀번호를 입력하세요');
    });
  });

  describe('validatePasswordMatch', () => {
    it('returns empty string when passwords match', () => {
      expect(validatePasswordMatch('password123', 'password123')).toBe('');
    });

    it('returns error message when passwords do not match', () => {
      expect(validatePasswordMatch('password123', 'password456')).toBe('비밀번호가 일치하지 않습니다');
    });

    it('returns error message for empty confirm password', () => {
      expect(validatePasswordMatch('', 'password123')).toBe('비밀번호 확인을 입력하세요');
    });
  });
});
