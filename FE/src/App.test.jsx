import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';

describe('App', () => {
  it('renders placeholder', () => {
    render(<App />);
    expect(screen.getByText(/placeholder/i)).toBeInTheDocument();
  });
});
