import React, { useState } from 'react';
import { signup } from '../api/auth.js';
import { validateEmail, validatePassword } from '../utils/validation.js';

export default function SignupForm() {
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
  const [submitSuccess, setSubmitSuccess] = useState(false);

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

    switch (name) {
      case 'email':
        error = validateEmail(value);
        break;
      case 'password':
        error = validatePassword(value);
        break;
      default:
        break;
    }

    setErrors(prev => ({ ...prev, [name]: error }));
  };

  const isFormValid = () => {
    return (
      formData.email &&
      formData.password &&
      !errors.email &&
      !errors.password &&
      validateEmail(formData.email) === '' &&
      validatePassword(formData.password) === ''
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    setTouched({
      email: true,
      password: true
    });

    validateField('email', formData.email);
    validateField('password', formData.password);

    if (!isFormValid()) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');
    setSubmitSuccess(false);

    try {
      const result = await signup({
        email: formData.email,
        password: formData.password
      });

      if (result.success) {
        setSubmitSuccess(true);
        setFormData({ email: '', password: '' });
        setTouched({ email: false, password: false });
        setErrors({ email: '', password: '' });
      } else {
        if (result.error === '이미 가입된 이메일입니다') {
          setErrors(prev => ({ ...prev, email: '이미 가입된 이메일입니다' }));
        } else {
          setSubmitError(result.error || '회원가입 중 오류가 발생했습니다');
        }
      }
    } catch (error) {
      setSubmitError('일시적인 오류가 발생했습니다. 다시 시도해주세요');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: '400px', margin: '20px auto' }}>
      <h2>회원가입</h2>

      {submitSuccess && (
        <div style={{ padding: '10px', marginBottom: '15px', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px' }}>
          회원가입이 완료되었습니다!
        </div>
      )}

      {submitError && (
        <div style={{ padding: '10px', marginBottom: '15px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px' }}>
          {submitError}
        </div>
      )}

      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="email" style={{ display: 'block', marginBottom: '5px' }}>이메일</label>
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
          style={{ width: '100%', padding: '8px', fontSize: '14px', borderColor: touched.email && errors.email ? 'red' : '#ccc' }}
        />
        {touched.email && errors.email && (
          <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>{errors.email}</div>
        )}
      </div>

      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="password" style={{ display: 'block', marginBottom: '5px' }}>비밀번호</label>
        <input
          type="password"
          id="password"
          name="password"
          value={formData.password}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder="8자 이상 입력"
          required
          autoComplete="new-password"
          aria-invalid={touched.password && errors.password ? 'true' : 'false'}
          style={{ width: '100%', padding: '8px', fontSize: '14px', borderColor: touched.password && errors.password ? 'red' : '#ccc' }}
        />
        {touched.password && errors.password && (
          <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>{errors.password}</div>
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
        {isSubmitting ? '처리 중...' : '회원가입'}
      </button>
    </form>
  );
}
