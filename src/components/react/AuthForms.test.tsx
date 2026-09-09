import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Account enumeration is the thing these forms must not do.
 *
 * Better Auth answers `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (422) for a taken
 * address and `EMAIL_NOT_VERIFIED` (403) for an existing-but-unverified account
 * versus 401 for anything else. Echoing those told an anonymous visitor which
 * addresses have accounts here — on a roster-backed neighbourhood site, that is
 * a membership disclosure. Every outcome must read identically.
 */

const auth = vi.hoisted(() => ({
  signUp: { email: vi.fn() },
  signIn: { email: vi.fn() },
  sendVerificationEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
}));

vi.mock('../../lib/auth-client', () => ({ authClient: auth }));

import { RegisterForm, LoginForm } from './AuthForms';

beforeEach(() => {
  vi.clearAllMocks();
  auth.sendVerificationEmail.mockResolvedValue({ error: null });
});

async function fillAndSubmit(button: string, fields: [string, string][]) {
  const user = userEvent.setup();
  for (const [placeholder, value] of fields) {
    await user.type(screen.getByPlaceholderText(placeholder), value);
  }
  await user.click(screen.getByRole('button', { name: button }));
}

const SIGN_UP_FIELDS: [string, string][] = [
  ['Full name', 'A Neighbour'],
  ['Email', 'someone@example.test'],
  ['Password (10+ chars)', 'a-long-enough-password'],
];

describe('RegisterForm', () => {
  it('says the same thing for a new address and a taken one', async () => {
    auth.signUp.email.mockResolvedValue({ error: null });
    const { unmount } = render(<RegisterForm />);
    await fillAndSubmit('Create account', SIGN_UP_FIELDS);
    const onSuccess = (await screen.findByText(/Check your email/i))
      .textContent;
    unmount();

    auth.signUp.email.mockResolvedValue({
      error: {
        code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
        message: 'User already exists. Use another email.',
        status: 422,
      },
    });
    render(<RegisterForm />);
    await fillAndSubmit('Create account', SIGN_UP_FIELDS);
    const onTaken = (await screen.findByText(/Check your email/i)).textContent;

    expect(onTaken).toBe(onSuccess);
    expect(screen.queryByText(/already exists/i)).toBeNull();
  });

  it('resends verification for a taken address, so the message is true', async () => {
    auth.signUp.email.mockResolvedValue({
      error: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', status: 422 },
    });
    render(<RegisterForm />);
    await fillAndSubmit('Create account', SIGN_UP_FIELDS);
    await screen.findByText(/Check your email/i);
    expect(auth.sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'someone@example.test' }),
    );
  });

  it('shows the same message even when the resend itself fails', async () => {
    auth.signUp.email.mockResolvedValue({
      error: { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', status: 422 },
    });
    auth.sendVerificationEmail.mockRejectedValue(new Error('smtp down'));
    render(<RegisterForm />);
    await fillAndSubmit('Create account', SIGN_UP_FIELDS);
    expect(await screen.findByText(/Check your email/i)).toBeTruthy();
  });
});

describe('LoginForm', () => {
  const LOGIN_FIELDS: [string, string][] = [
    ['Email', 'someone@example.test'],
    ['Password', 'a-long-enough-password'],
  ];

  it('says the same thing for bad credentials and an unverified account', async () => {
    auth.signIn.email.mockResolvedValue({
      error: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 },
    });
    const { unmount } = render(<LoginForm />);
    await fillAndSubmit('Sign in', LOGIN_FIELDS);
    const onBadPassword = (await screen.findByText(/could not sign you in/i))
      .textContent;
    unmount();

    auth.signIn.email.mockResolvedValue({
      error: {
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Email not verified',
        status: 403,
      },
    });
    render(<LoginForm />);
    await fillAndSubmit('Sign in', LOGIN_FIELDS);
    const onUnverified = (await screen.findByText(/could not sign you in/i))
      .textContent;

    expect(onUnverified).toBe(onBadPassword);
    expect(screen.queryByText(/not verified/i)).toBeNull();
  });
});
