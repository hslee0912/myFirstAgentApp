import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SignupForm from './SignupForm.jsx';
import * as authApi from '../api/auth.js';

vi.mock('../api/auth.js');

describe('SignupForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all form fields', () => {
    render(<SignupForm />);
    expect(screen.getByLabelText(/이메일/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^비밀번호$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /회원가입/i })).toBeInTheDocument();
  });

  it('validates email format on blur', async () => {
    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    
    fireEvent.change(emailInput, { target: { value: 'invalid-email' } });
    fireEvent.blur(emailInput);

    await waitFor(() => {
      expect(screen.getByText(/올바른 이메일 형식을 입력하세요/i)).toBeInTheDocument();
    });
  });

  it('validates password length on blur', async () => {
    render(<SignupForm />);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    
    fireEvent.change(passwordInput, { target: { value: 'short' } });
    fireEvent.blur(passwordInput);

    await waitFor(() => {
      expect(screen.getByText(/비밀번호는 8자 이상이어야 합니다/i)).toBeInTheDocument();
    });
  });

  it('disables submit button when form is invalid', () => {
    render(<SignupForm />);
    const submitButton = screen.getByRole('button', { name: /회원가입/i });
    expect(submitButton).toBeDisabled();
  });

  it('enables submit button when form is valid', async () => {
    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });

    await waitFor(() => {
      const submitButton = screen.getByRole('button', { name: /회원가입/i });
      expect(submitButton).not.toBeDisabled();
    });
  });

  it('calls signup API on valid form submission', async () => {
    authApi.signup.mockResolvedValue({
      success: true,
      data: {
        userId: 'uuid-1234',
        email: 'test@example.com'
      }
    });

    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    const submitButton = screen.getByRole('button', { name: /회원가입/i });
    
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(authApi.signup).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123'
      });
    });
  });

  it('displays success message on successful signup', async () => {
    authApi.signup.mockResolvedValue({
      success: true,
      data: {
        userId: 'uuid-1234',
        email: 'test@example.com'
      }
    });

    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    const submitButton = screen.getByRole('button', { name: /회원가입/i });
    
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/회원가입이 완료되었습니다/i)).toBeInTheDocument();
    });
  });

  it('displays error message on duplicate email', async () => {
    authApi.signup.mockResolvedValue({
      success: false,
      error: '이미 가입된 이메일입니다'
    });

    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    const submitButton = screen.getByRole('button', { name: /회원가입/i });
    
    fireEvent.change(emailInput, { target: { value: 'existing@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/이미 가입된 이메일입니다/i)).toBeInTheDocument();
    });
  });

  it('displays generic error message on server error', async () => {
    authApi.signup.mockRejectedValue(new Error('Network error'));

    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    const submitButton = screen.getByRole('button', { name: /회원가입/i });
    
    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/일시적인 오류가 발생했습니다/i)).toBeInTheDocument();
    });
  });

  it('shows loading state during submission', async () => {
    authApi.signup.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ success: true, data: { userId: 'uuid-1234', email: 'test@example.com' } }), 100)));

    render(<SignupForm />);
    const emailInput = screen.getByLabelText(/이메일/i);
    const passwordInput = screen.getByLabelText(/^비밀번호$/i);
    const submitButton = screen.getByRole('button', { name: /회원가입/i });

    fireEvent.change(emailInput, { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.click(submitButton);

    expect(screen.getByRole('button', { name: /처리 중.../i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /처리 중.../i })).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText(/회원가입이 완료되었습니다/i)).toBeInTheDocument();
    });
  });
});
