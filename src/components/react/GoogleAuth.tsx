import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

/**
 * Individual Google sign-in (#415). Google is an optional way into a
 * personal site Account — it grants no homeowner or board access by itself,
 * which still follows Person Verification and the roster.
 */

/**
 * The login page's copy for a failed Google redirect. Better Auth sends the
 * browser back to `/login?error=<code>`; every code gets the site's own words.
 *
 * `account_not_linked` does say an Account uses the address. That is not the
 * enumeration the password form guards against: the server refuses every
 * identity whose email Google has not verified before looking anything up
 * (`unable_to_get_user_info`, whatever the address), so only the address's
 * Google-verified owner can reach it.
 */
export function googleSignInError(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'Google sign-in was cancelled. Try again, or sign in with your email and password.';
    case 'account_not_linked':
      return 'An account on this site already uses that email address. Sign in with your email and password, then connect Google from your Account page.';
    case 'unable_to_get_user_info':
      return 'We could not sign you in with Google. Google must show a verified email address for that Google account.';
    default:
      return 'We could not sign you in with Google. Please try again.';
  }
}

/** The Account page's copy for a failed connect (`/account?error=<code>`). */
export function googleLinkError(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'Connecting Google was cancelled.';
    case 'email_does_not_match':
      return 'That Google account uses a different email address. Connect the Google account that uses the same email address as this account.';
    case 'account_already_linked_to_different_user':
      return 'That Google account is already connected to a different account on this site.';
    case 'unable_to_get_user_info':
      return 'Google did not show a verified email address for that Google account, so it could not be connected.';
    case 'SESSION_NOT_FRESH':
      return 'For your security, sign out and sign in again, then retry.';
    default:
      return 'Could not connect Google. Please try again.';
  }
}

/** The `?error=` Better Auth appended to this page's URL, if any. */
export function readErrorParam(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('error') ?? '';
}

export function GoogleSignInButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onClick() {
    setError('');
    setBusy(true);
    try {
      // On success the client navigates to Google; this page does not return.
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: '/',
        newUserCallbackURL: '/verify-property',
        errorCallbackURL: '/login',
      });
      if (result.error) {
        setError(googleSignInError(''));
        setBusy(false);
      }
    } catch {
      setError(googleSignInError(''));
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={onClick} disabled={busy}>
        {label}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export interface SignInMethod {
  /** Better Auth's account row ID — what `/unlink-account` takes. */
  id: string;
  providerId: string;
}

/**
 * The Account page's sign-in methods: connect or disconnect Google, and a
 * password-setup link for an Account that has only Google. Better Auth
 * refuses to remove the last method; the page says so before it is asked.
 */
export function SignInMethods({
  googleEnabled,
  email,
  methods: initialMethods,
}: {
  googleEnabled: boolean;
  email: string;
  methods: SignInMethod[];
}) {
  const [methods, setMethods] = useState(initialMethods);
  const [msg, setMsg] = useState(() => {
    const code = readErrorParam();
    return code ? googleLinkError(code) : '';
  });
  const [busy, setBusy] = useState(false);

  const google = methods.find((m) => m.providerId === 'google');
  const hasPassword = methods.some((m) => m.providerId === 'credential');

  async function connect() {
    setMsg('');
    setBusy(true);
    try {
      const result = await authClient.linkSocial({
        provider: 'google',
        callbackURL: '/account',
        errorCallbackURL: '/account',
      });
      if (result.error) {
        setMsg(googleLinkError(result.error.code ?? ''));
        setBusy(false);
      }
    } catch {
      setMsg(googleLinkError(''));
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!google) return;
    setMsg('');
    setBusy(true);
    try {
      const result = await authClient.unlinkAccount({ accountId: google.id });
      if (result.error) {
        setMsg(
          result.error.code === 'SESSION_NOT_FRESH'
            ? googleLinkError('SESSION_NOT_FRESH')
            : 'Could not disconnect Google. Please try again.',
        );
        return;
      }
      setMethods((current) => current.filter((m) => m.id !== google.id));
      setMsg('Google is disconnected. Sign in with your email and password.');
    } catch {
      setMsg('Could not disconnect Google. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function sendPasswordLink() {
    setMsg('');
    setBusy(true);
    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: '/reset-password',
      });
      setMsg(
        result.error
          ? 'Could not send the email. Please try again.'
          : `We sent a link to ${email} to set a password.`,
      );
    } catch {
      setMsg('Could not send the email. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-stack">
      <ul>
        <li>Email and password: {hasPassword ? 'set up' : 'not set up'}</li>
        <li>Google: {google ? 'connected' : 'not connected'}</li>
      </ul>
      {!hasPassword && (
        <p>
          <button type="button" onClick={sendPasswordLink} disabled={busy}>
            Email me a link to set a password
          </button>
        </p>
      )}
      {google ? (
        hasPassword ? (
          <button type="button" onClick={disconnect} disabled={busy}>
            Disconnect Google
          </button>
        ) : (
          <p>
            Google is your only way to sign in. Set a password before you
            disconnect it.
          </p>
        )
      ) : (
        googleEnabled && (
          <button type="button" onClick={connect} disabled={busy}>
            Connect Google
          </button>
        )
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
