import React, { useState } from 'react';
import SignupPage from './pages/SignupPage.jsx';

export default function App() {
  const [currentPage, setCurrentPage] = useState('placeholder');

  if (currentPage === 'signup') {
    return <SignupPage onBack={() => setCurrentPage('placeholder')} />;
  }

  return (
    <div>
      <div>App placeholder</div>
      <button onClick={() => setCurrentPage('signup')}>Go to Signup</button>
    </div>
  );
}
