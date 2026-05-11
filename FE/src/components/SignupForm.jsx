import React, { useState } from 'react';
import { signup } from '../api/auth.js';
import { validateEmail } from '../utils/validateEmail.js';

export default function SignupForm({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [apiError, setApiError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleEmailChange = (e) => {
    const value = e.target.value;
    setEmail(value);
    setEmailError('');
    setApiError('');
  };

  const handlePasswordChange = (e) => {
    const value = e.target.value;
    setPassword(value);
    setPasswordError('');
    setApiError('');
  };

  const validateForm = () => {
    let isValid = true;

    if (!validateEmail(email)) {
      setEmailError('올바른 이메일 형식을 입력해주세요');
      isValid = false;
    }

    if (password.length < 8) {
      setPasswordError('비밀번호는 8자 이상이어야 합니다');
      isValid = false;
    }

    return isValid;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError('');

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await signup({ email, password });

      if (response.success) {
        if (onSuccess) {
          onSuccess();
        }
      } else {
        setApiError(response.error || '회원가입에 실패했습니다');
      }
    } catch (error) {
      setApiError('네트워크 오류가 발생했습니다');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <div>
        <label htmlFor="email" style={{ display: 'block', marginBottom: '5px' }}>
          이메일
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={handleEmailChange}
          placeholder="example@example.com"
          style={{
            width: '100%',
            padding: '8px',
            border: emailError ? '1px solid red' : '1px solid #ccc',
            borderRadius: '4px'
          }}
        />
        {emailError && (
          <div style={{ color: 'red', fontSize: '14px', marginTop: '5px' }}>
            {emailError}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="password" style={{ display: 'block', marginBottom: '5px' }}>
          비밀번호
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={handlePasswordChange}
          placeholder="8자 이상 입력"
          style={{
            width: '100%',
            padding: '8px',
            border: passwordError ? '1px solid red' : '1px solid #ccc',
            borderRadius: '4px'
          }}
        />
        {passwordError && (
          <div style={{ color: 'red', fontSize: '14px', marginTop: '5px' }}>
            {passwordError}
          </div>
        )}
      </div>

      {apiError && (
        <div style={{ color: 'red', fontSize: '14px', padding: '10px', backgroundColor: '#fee', borderRadius: '4px' }}>
          {apiError}
        </div>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        style={{
          padding: '10px',
          backgroundColor: isSubmitting ? '#ccc' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: isSubmitting ? 'not-allowed' : 'pointer',
          fontSize: '16px'
        }}
      >
        {isSubmitting ? '처리 중...' : '회원가입'}
      </button>
    </form>
  );
}
