import React, { useState } from 'react';
import SignupForm from '../components/SignupForm.jsx';

export default function SignupPage({ onBack }) {
  const [signupSuccess, setSignupSuccess] = useState(false);

  const handleSignupSuccess = () => {
    setSignupSuccess(true);
  };

  if (signupSuccess) {
    return (
      <div style={{ padding: '20px' }}>
        <h2>회원가입 완료</h2>
        <p>회원가입이 완료되었습니다. 로그인 페이지로 이동합니다.</p>
        <button onClick={onBack}>홈으로 돌아가기</button>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', maxWidth: '400px', margin: '0 auto' }}>
      <h1>회원가입</h1>
      <SignupForm onSuccess={handleSignupSuccess} />
      {onBack && (
        <button onClick={onBack} style={{ marginTop: '10px' }}>
          뒤로 가기
        </button>
      )}
    </div>
  );
}
