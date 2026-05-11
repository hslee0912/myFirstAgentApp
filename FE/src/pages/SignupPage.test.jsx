import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SignupPage from './SignupPage';

describe('SignupPage (auto-generated smoke test)', () => {
  it('renders without crashing and produces non-empty output', () => {
    const { container } = render(<SignupPage />);
    expect(container).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
  });
});
