import React, { useState } from 'react';
import SignupForm from './SignupForm.jsx';

export default function SignupModal({ isOpen = false, onClose }) {
  const [signupSuccess, setSignupSuccess] = useState(false);

  const handleSignupSuccess = () => {
    setSignupSuccess(true);
  };

  const handleClose = () => {
    setSignupSuccess(false);
    if (onClose) {
      onClose();
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  if (!isOpen) {
    return <div data-state="closed" style={{ display: 'none' }} />;
  }

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        zIndex: 999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        style={{
          position: 'relative',
          background: 'white',
          borderRadius: '8px',
          padding: '24px',
          maxWidth: '400px',
          width: '90%',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
        }}
      >
        <button
          onClick={handleClose}
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            background: 'none',
            border: 'none',
            fontSize: '24px',
            cursor: 'pointer',
            color: '#333',
            lineHeight: 1
          }}
          aria-label="닫기"
        >
          ×
        </button>

        {signupSuccess ? (
          <div>
            <h2 style={{ marginTop: '10px' }}>회원가입 완료</h2>
            <p>회원가입이 완료되었습니다. 로그인 페이지로 이동합니다.</p>
            <button
              onClick={handleClose}
              style={{
                marginTop: '20px',
                padding: '10px 20px',
                background: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '16px'
              }}
            >
              확인
            </button>
          </div>
        ) : (
          <div>
            <h1 style={{ marginTop: '10px', marginBottom: '20px' }}>회원가입</h1>
            <SignupForm onSuccess={handleSignupSuccess} />
          </div>
        )}
      </div>
    </div>
  );
}
