import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import App from './App';

describe('App (auto-generated smoke test)', () => {
  it('renders without crashing and produces non-empty output', () => {
    const { container } = render(<App />);
    expect(container).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
  });
});
