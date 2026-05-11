import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SignupForm from './SignupForm';

describe('SignupForm (auto-generated smoke test)', () => {
  it('renders without crashing and produces non-empty output', () => {
    const { container } = render(<SignupForm />);
    expect(container).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
  });
});
