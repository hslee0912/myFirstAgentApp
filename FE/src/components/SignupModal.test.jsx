import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SignupModal from './SignupModal';

describe('SignupModal (auto-generated smoke test)', () => {
  it('renders without crashing and produces non-empty output', () => {
    const { container } = render(<SignupModal />);
    expect(container).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
  });
});
