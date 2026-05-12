import React, { useState } from 'react';
import SignupModal from './components/SignupModal.jsx';

export default function App() {
  const [currentPage, setCurrentPage] = useState('placeholder');
  const [isSignupModalOpen, setIsSignupModalOpen] = useState(false);

  if (currentPage === 'signup') {
    return (
      <div style={{ background: '#000', minHeight: '100vh', padding: '20px' }}>
        <SignupModal
          isOpen={true}
          onClose={() => setCurrentPage('placeholder')}
        />
      </div>
    );
  }

  return (
    <div style={{ background: '#000', minHeight: '100vh', padding: '20px', color: '#fff' }}>
      <div>App placeholder</div>
      <button
        onClick={() => setIsSignupModalOpen(true)}
        style={{
          marginTop: '10px',
          padding: '10px 20px',
          background: '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer'
        }}
      >
        회원가입
      </button>
      <button
        onClick={() => setCurrentPage('signup')}
        style={{
          marginLeft: '10px',
          padding: '10px 20px',
          background: '#28a745',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer'
        }}
      >
        Go to Signup
      </button>
      <SignupModal
        isOpen={isSignupModalOpen}
        onClose={() => setIsSignupModalOpen(false)}
      />
    </div>
  );
}
