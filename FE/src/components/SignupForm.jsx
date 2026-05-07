import React, { useState } from 'react';
import { signup } from '../api/auth.js';
import { validateEmail, validatePassword, validatePasswordMatch } from '../utils/validation.js';

export default function SignupForm() {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    password_confirm: ''
  });

  const [errors, setErrors] = useState({
    email: '',
    password: '',
    password_confirm: ''
  });

  const [touched, setTouched] = useState({
    email: false,
    password: false,
    password_confirm: false
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
      case 'password_confirm':
        error = validatePasswordMatch(value, formData.password);
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
      formData.password_confirm &&
      !errors.email &&
      !errors.password &&
      !errors.password_confirm &&
      validateEmail(formData.email) === '' &&
      validatePassword(formData.password) === '' &&
      validatePasswordMatch(formData.password_confirm, formData.password) === ''
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    setTouched({
      email: true,
      password: true,
      password_confirm: true
    });

    validateField('email', formData.email);
    validateField('password', formData.password);
    validateField('password_confirm', formData.password_confirm);

    if (!isFormValid()) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError('');

    try {
      const result = await signup({
        email: formData.email,
        password: formData.password
      });

      if (result.success) {
        setSubmitSuccess(true);
        setFormData({ email: '', password: '', password_confirm: '' });
        setTouched({ email: false, password: false, password_confirm: false });
        setErrors({ email: '', password: '', password_confirm: '' });
      } else {
        if (result.error === 'Email already exists') {
          setErrors(prev => ({ ...prev, email: '이미 사용 중인 이메일입니다' }));
        } else if (result.details && Array.isArray(result.details)) {
          const newErrors = { ...errors };
          result.details.forEach(detail => {
            if (detail.field && detail.message) {
              newErrors[detail.field] = detail.message;
            }
          });
          setErrors(newErrors);
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

      <div style={{ marginBottom: '15px' }}>
        <label htmlFor="password_confirm" style={{ display: 'block', marginBottom: '5px' }}>비밀번호 확인</label>
        <input
          type="password"
          id="password_confirm"
          name="password_confirm"
          value={formData.password_confirm}
          onChange={handleChange}
          onBlur={handleBlur}
          placeholder="비밀번호 재입력"
          required
          autoComplete="new-password"
          aria-invalid={touched.password_confirm && errors.password_confirm ? 'true' : 'false'}
          style={{ width: '100%', padding: '8px', fontSize: '14px', borderColor: touched.password_confirm && errors.password_confirm ? 'red' : '#ccc' }}
        />
        {touched.password_confirm && errors.password_confirm && (
          <div style={{ color: 'red', fontSize: '12px', marginTop: '5px' }}>{errors.password_confirm}</div>
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
