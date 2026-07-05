import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../lib/auth-client', () => ({
  authClient: { signOut: vi.fn().mockResolvedValue(undefined) },
}));

import SignOutButton from './SignOutButton';
import { authClient } from '../../lib/auth-client';

describe('SignOutButton', () => {
  const realLocation = window.location;
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign: vi.fn() },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: realLocation,
    });
    vi.clearAllMocks();
  });

  it('signs the user out and navigates home so the chrome re-renders', async () => {
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
    expect(window.location.assign).toHaveBeenCalledWith('/');
  });
});
