import React, { useState } from 'react';
import { login } from '../../api/auth.js';

/**
 * 로그인 폼 컴포넌트
 * 이메일/비밀번호 입력 받아 POST /api/v1/auth/login 호출
 */
export default function LoginForm() {
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });

  const [errors, setErrors] = useState({
    email: '',
    password: ''
  });

  const [touched, setTouched] = useState({
    email: false,
    password: false
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));

    if (touched[name]) {
      validateField(name, value);
    }
  };

  const handleBlur = (e) => {
    const { name, value } = e.target;
    setTouched(prev => ({ ...prev, [name]: true }));
    validateField(name, value);
  };

  const validateField = (name, value) => {
    let error = '';

    if (name === 'email') {
      if (!value) {
        error = '이메일을 입력하세요';
      } else {
        const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!pattern.test(value)) {
          error = '올바른 이메일 형식을 입력하세요';
        }
      }
    } else if (name === 'password') {
      if (!value) {
        error = '비밀번호를 입력하세요';
      }
    }

    setErrors(prev => ({ ...prev, [name]: error }));
  };

  const isFormValid = () => {
    return (
      formData.email &&
      formData.password &&
      !errors.email &&
      !errors.password
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    setTouched({ email: true, password: true });
    validateField('email', formData.email);
    validateField('password', formData.password);

    if (!isFormValid()) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    try {
      const result = await login({
        email: formData.email,
        password: formData.password
      });

      if (result.success) {
        const userId = result.data.user_id;
        localStorage.setItem('user_id', userId.toString());
        window.location.href = '/dashboard';
      } else {
        if (result.error === 'Invalid email or password') {
          setSubmitError('이메일 또는 비밀번호가 올바르지 않습니다');
        } else {
          setSubmitError(result.error || '로그인 실패. 다시 시도해주세요');
        }
      }
    } catch (error) {
      setSubmitError('로그인 실패. 다시 시도해주세요');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: '400px', margin: '20px auto' }}>
      <h2>로그인</h2>

      {submitError && (
        <div
          role="alert"
          style={{
            padding: '10px',
            marginBottom: '15px',
            backgroundColor: '#f8d7da',
            color: '#721c24',
            borderRadius: '4px'
          }}
        >
          {submitError}
        </div>
      )}

      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="email" style={{ display: 'block', marginBottom: '5px' }}>
          이메일
        </label>
        <input
          type="email"
          id="email"
          name="email"
          value={formData.email}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder="example@email.com"
          required
          autoComplete="email"
          aria-invalid={touched.email && errors.email ? 'true' : 'false'}
          style={{
            width: '100%',
            padding: '8px',
            fontSize: '14px',
            borderColor: touched.email && errors.email ? 'red' : '#ccc'
          }}
        />
        {touched.email && errors.email && (
          <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>
            {errors.email}
          </div>
        )}
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="password" style={{ display: 'block', marginBottom: '5px' }}>
          비밀번호
        </label>
        <input
          type="password"
          id="password"
          name="password"
          value={formData.password}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder="비밀번호 입력"
          required
          autoComplete="current-password"
          aria-invalid={touched.password && errors.password ? 'true' : 'false'}
          style={{
            width: '100%',
            padding: '8px',
            fontSize: '14px',
            borderColor: touched.password && errors.password ? 'red' : '#ccc'
          }}
        />
        {touched.password && errors.password && (
          <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>
            {errors.password}
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={!isFormValid() || isSubmitting}
        style={{
          width: '100%',
          padding: '10px',
          fontSize: '16px',
          backgroundColor: !isFormValid() || isSubmitting ? '#ccc' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: !isFormValid() || isSubmitting ? 'not-allowed' : 'pointer'
        }}
      >
        {isSubmitting ? '로그인 중...' : '로그인'}
      </button>
    </form>
  );
}
