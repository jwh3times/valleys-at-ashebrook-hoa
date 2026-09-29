import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const auth = vi.hoisted(() => ({
  signUp: { email: vi.fn() },
  signIn: { email: vi.fn(), social: vi.fn() },
  sendVerificationEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  linkSocial: vi.fn(),
  unlinkAccount: vi.fn(),
}));

vi.mock('../../lib/auth-client', () => ({ authClient: auth }));

import { LoginForm, RegisterForm } from './AuthForms';
import {
  GoogleSignInButton,
  SignInMethods,
  googleSignInError,
} from './GoogleAuth';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('GoogleSignInButton', () => {
  it('starts the Google redirect with the site callbacks', async () => {
    auth.signIn.social.mockResolvedValue({ error: null });
    render(<GoogleSignInButton label="Sign in with Google" />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    );
    expect(auth.signIn.social).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: '/',
      newUserCallbackURL: '/verify-property',
      errorCallbackURL: '/login',
    });
  });

  it('shows an actionable message when Google cannot be started', async () => {
    auth.signIn.social.mockResolvedValue({
      error: { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' },
    });
    render(<GoogleSignInButton label="Sign in with Google" />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    );
    expect(
      await screen.findByText(/could not sign you in with Google/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Provider not found/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    ).toBeEnabled();
  });
});

describe('LoginForm with Google', () => {
  it('offers Google only when it is configured', () => {
    const { unmount } = render(<LoginForm />);
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull();
    unmount();

    render(<LoginForm googleEnabled />);
    expect(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    ).toBeInTheDocument();
  });

  it('explains a same-email collision instead of merging silently', () => {
    window.history.replaceState({}, '', '/login?error=account_not_linked');
    render(<LoginForm googleEnabled />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Sign in with your email and password, then connect Google from your Account page/,
    );
  });

  it('explains a cancelled Google consent', () => {
    window.history.replaceState({}, '', '/login?error=access_denied');
    render(<LoginForm googleEnabled />);
    expect(screen.getByRole('alert')).toHaveTextContent(/cancelled/);
  });

  it('shows no Google message on an ordinary visit', () => {
    render(<LoginForm googleEnabled />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('RegisterForm with Google', () => {
  it('offers Google sign-up only when it is configured', () => {
    const { unmount } = render(<RegisterForm />);
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull();
    unmount();

    render(<RegisterForm googleEnabled />);
    expect(
      screen.getByRole('button', { name: 'Sign up with Google' }),
    ).toBeInTheDocument();
  });
});

describe('googleSignInError', () => {
  it('never echoes an unknown code', () => {
    expect(googleSignInError('<script>state_mismatch')).toBe(
      'We could not sign you in with Google. Please try again.',
    );
  });
});

const PASSWORD = { id: 'acct-row-password', providerId: 'credential' };
const GOOGLE = { id: 'acct-row-google', providerId: 'google' };

describe('SignInMethods', () => {
  it('connects Google from the signed-in Account', async () => {
    auth.linkSocial.mockResolvedValue({ error: null });
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[PASSWORD]}
      />,
    );
    expect(screen.getByText('Google: not connected')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Connect Google' }),
    );
    expect(auth.linkSocial).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: '/account',
      errorCallbackURL: '/account',
    });
  });

  it('asks for a fresh sign-in when the session is too old to link', async () => {
    auth.linkSocial.mockResolvedValue({
      error: { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh' },
    });
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[PASSWORD]}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Connect Google' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /sign out and sign in again/,
    );
  });

  it('does not offer to connect Google when it is not configured', () => {
    render(
      <SignInMethods
        googleEnabled={false}
        email="resident@example.test"
        methods={[PASSWORD]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Connect Google' })).toBeNull();
  });

  it('explains a Google account with a different email', () => {
    window.history.replaceState({}, '', '/account?error=email_does_not_match');
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[PASSWORD]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /uses a different email address/,
    );
  });

  it('explains a Google account already connected elsewhere', () => {
    window.history.replaceState(
      {},
      '',
      '/account?error=account_already_linked_to_different_user',
    );
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[PASSWORD]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /already connected to a different account/,
    );
  });

  it('disconnects Google by its account row when a password remains', async () => {
    auth.unlinkAccount.mockResolvedValue({ error: null });
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[PASSWORD, GOOGLE]}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Disconnect Google' }),
    );
    expect(auth.unlinkAccount).toHaveBeenCalledWith({
      accountId: 'acct-row-google',
    });
    expect(
      await screen.findByText('Google: not connected'),
    ).toBeInTheDocument();
  });

  it('keeps Google connected when the disconnect fails', async () => {
    auth.unlinkAccount.mockResolvedValue({
      error: { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh' },
    });
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[PASSWORD, GOOGLE]}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Disconnect Google' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /sign out and sign in again/,
    );
    expect(screen.getByText('Google: connected')).toBeInTheDocument();
  });

  it('will not offer to remove the only sign-in method, and offers a password instead', async () => {
    auth.requestPasswordReset.mockResolvedValue({ error: null });
    render(
      <SignInMethods
        googleEnabled
        email="resident@example.test"
        methods={[GOOGLE]}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Disconnect Google' }),
    ).toBeNull();
    expect(
      screen.getByText(/Google is your only way to sign in/),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Email me a link to set a password' }),
    );
    expect(auth.requestPasswordReset).toHaveBeenCalledWith({
      email: 'resident@example.test',
      redirectTo: '/reset-password',
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      /resident@example.test/,
    );
  });
});
