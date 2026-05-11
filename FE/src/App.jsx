import React from 'react';
import SignupForm from './components/SignupForm.jsx';

export default function App() {
  return (
    <div style={{ maxWidth: '400px', margin: '50px auto', padding: '20px' }}>
      <h1>회원가입</h1>
      <SignupForm />
      <div style={{ marginTop: '20px', color: '#666', fontSize: '14px' }}>App placeholder</div>
    </div>
  );
}
