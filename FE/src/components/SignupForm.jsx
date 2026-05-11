import React, { useState } from 'react';
import { signup } from '../api/auth.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const validateEmail = (value) => {
    if (!value) {
      return '이메일을 입력하세요.';
    }
    if (value.length > 255) {
      return '이메일은 255자 이하여야 합니다.';
    }
    if (!EMAIL_REGEX.test(value)) {
      return '유효한 이메일을 입력하세요.';
    }
    return '';
  };

  const validatePassword = (value) => {
    if (!value) {
      return '비밀번호를 입력하세요.';
    }
    if (value.length < 8) {
      return '비밀번호는 8자 이상이어야 합니다.';
    }
    return '';
  };

  const handleEmailChange = (e) => {
    const value = e.target.value;
    setEmail(value);
    setEmailError(validateEmail(value));
    setSubmitError('');
  };

  const handlePasswordChange = (e) => {
    const value = e.target.value;
    setPassword(value);
    setPasswordError(validatePassword(value));
    setSubmitError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);

    setEmailError(emailErr);
    setPasswordError(passwordErr);

    if (emailErr || passwordErr) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    try {
      const result = await signup({ email, password });
      
      if (result.success) {
        setSuccess(true);
        setEmail('');
        setPassword('');
      } else {
        const errorMessages = {
          'INVALID_EMAIL': '유효하지 않은 이메일 형식입니다.',
          'PASSWORD_TOO_SHORT': '비밀번호는 8자 이상이어야 합니다.',
          'EMAIL_ALREADY_EXISTS': '이미 가입된 이메일입니다.'
        };
        setSubmitError(errorMessages[result.error] || result.error || '회원가입에 실패했습니다.');
      }
    } catch (error) {
      setSubmitError('서버와의 통신에 실패했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (success) {
    return (
      <div style={{ padding: '20px', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px' }}>
        <p>회원가입이 완료되었습니다!</p>
        <p style={{ fontSize: '14px', marginTop: '10px' }}>로그인 페이지로 이동해주세요.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <div>
        <input
          type="email"
          value={email}
          onChange={handleEmailChange}
          placeholder="이메일 주소"
          disabled={isSubmitting}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '14px',
            border: emailError ? '1px solid #dc3545' : '1px solid #ccc',
            borderRadius: '4px',
            boxSizing: 'border-box'
          }}
        />
        {emailError && (
          <div style={{ color: '#dc3545', fontSize: '12px', marginTop: '5px' }}>
            {emailError}
          </div>
        )}
      </div>

      <div>
        <input
          type="password"
          value={password}
          onChange={handlePasswordChange}
          placeholder="비밀번호 (8자 이상)"
          disabled={isSubmitting}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '14px',
            border: passwordError ? '1px solid #dc3545' : '1px solid #ccc',
            borderRadius: '4px',
            boxSizing: 'border-box'
          }}
        />
        {passwordError && (
          <div style={{ color: '#dc3545', fontSize: '12px', marginTop: '5px' }}>
            {passwordError}
          </div>
        )}
      </div>

      {submitError && (
        <div style={{ padding: '10px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', fontSize: '14px' }}>
          {submitError}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        style={{
          padding: '10px 20px',
          fontSize: '16px',
          backgroundColor: isSubmitting ? '#6c757d' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: isSubmitting ? 'not-allowed' : 'pointer'
        }}
      >
        {isSubmitting ? '처리 중...' : '가입하기'}
      </button>
    </form>
  );
}
