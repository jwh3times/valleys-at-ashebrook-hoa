import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Control the "configured" flag per test via a live getter on the mock.
const state = vi.hoisted(() => ({ configured: false }));
vi.mock('../../lib/firebase', () => ({
  get isFirebaseConfigured() {
    return state.configured;
  },
}));

import ConfigNotice from './ConfigNotice';

describe('ConfigNotice', () => {
  beforeEach(() => {
    state.configured = false;
  });

  it('shows a setup notice when Firebase is not configured', () => {
    state.configured = false;
    render(<ConfigNotice />);
    expect(screen.getByText(/Setup needed/i)).toBeInTheDocument();
  });

  it('renders nothing once Firebase is configured', () => {
    state.configured = true;
    const { container } = render(<ConfigNotice />);
    expect(container).toBeEmptyDOMElement();
  });
});
