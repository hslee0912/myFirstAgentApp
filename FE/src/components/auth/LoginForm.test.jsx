import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginForm from './LoginForm.jsx';
import * as authApi from '../../api/auth.js';

vi.mock('../../api/auth.js');

const mockLocalStorage = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value.toString(); },
    clear: () => { store = {}; }
  };
})();

Object.defineProperty(window, 'localStorage', { value: mockLocalStorage });

delete window.location;
window.location = { href: '' };

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.clear();
    window.location.href = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all form fields', () => {
    render(<LoginForm />);
    expect(screen.getByLabelText(/이메일/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/비밀번호/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /로그인/i })).toBeInTheDocument();
  });

  it('validates email format on blur', async () => {
    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);

    fireEvent.change(emailInput, { target: { value: 'invalid-email' } });
    fireEvent.blur(emailInput);

    await waitFor(() => {
      expect(screen.getByText(/올바른 이메일 형식을 입력하세요/i)).toBeInTheDocument();
    });
  });

  it('shows error when password is empty on blur', async () => {
    render(<LoginForm />);
    const passwordInput = screen.getByLabelText(/비밀번호/i);

    fireEvent.change(passwordInput, { target: { value: '' } });
    fireEvent.blur(passwordInput);

    await waitFor(() => {
      expect(screen.getByText(/비밀번호를 입력하세요/i)).toBeInTheDocument();
    });
  });

  it('disables submit button when form is invalid', () => {
    render(<LoginForm />);
    const submitButton = screen.getByRole('button', { name: /로그인/i });
    expect(submitButton).toBeDisabled();
  });

  it('enables submit button when form is valid', async () => {
    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/비밀번호/i);

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });

    await waitFor(() => {
      const submitButton = screen.getByRole('button', { name: /로그인/i });
      expect(submitButton).not.toBeDisabled();
    });
  });

  it('calls login API on valid form submission', async () => {
    authApi.login.mockResolvedValue({
      success: true,
      data: { user_id: 12345 }
    });

    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/비밀번호/i);
    const submitButton = screen.getByRole('button', { name: /로그인/i });

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(authApi.login).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123'
      });
    });
  });

  it('stores user_id and redirects on successful login', async () => {
    authApi.login.mockResolvedValue({
      success: true,
      data: { user_id: 12345 }
    });

    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/비밀번호/i);
    const submitButton = screen.getByRole('button', { name: /로그인/i });

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockLocalStorage.getItem('user_id')).toBe('12345');
      expect(window.location.href).toBe('/dashboard');
    });
  });

  it('displays error message on invalid credentials', async () => {
    authApi.login.mockResolvedValue({
      success: false,
      error: 'Invalid email or password'
    });

    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/비밀번호/i);
    const submitButton = screen.getByRole('button', { name: /로그인/i });

    fireEvent.change(emailInput, { target: { value: 'wrong@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'wrongpass' } });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/이메일 또는 비밀번호가 올바르지 않습니다/i);
    });
  });

  it('displays generic error message on network error', async () => {
    authApi.login.mockRejectedValue(new Error('Network error'));

    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/비밀번호/i);
    const submitButton = screen.getByRole('button', { name: /로그인/i });

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/로그인 실패. 다시 시도해주세요/i);
    });
  });

  it('shows loading state during submission', async () => {
    authApi.login.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ success: true, data: { user_id: 12345 } }), 100)));

    render(<LoginForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/비밀번호/i);
    const submitButton = screen.getByRole('button', { name: /로그인/i });

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(submitButton);

    expect(screen.getByRole('button', { name: /로그인 중.../i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /로그인 중.../i })).toBeDisabled();

    await waitFor(() => {
      expect(window.location.href).toBe('/dashboard');
    });
  });
});
