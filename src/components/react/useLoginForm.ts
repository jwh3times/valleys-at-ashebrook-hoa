import { useState, type FormEvent } from 'react';
import { authClient } from '../../lib/auth-client';

type LoginCopy = {
  signInFailed: string;
  resetNeedsEmail: string;
  resetFailed: string;
  resetSent: string;
};

const DEFAULT_COPY: LoginCopy = {
  signInFailed:
    'We could not sign you in. Check your email and password — and if you have not confirmed your email address yet, use the link from your sign-up email first.',
  resetNeedsEmail: 'Enter your email first, then click reset.',
  resetFailed: 'Could not send reset email.',
  resetSent: 'If that email exists, a reset link is on its way.',
};

export function useLoginForm({
  copy = DEFAULT_COPY,
  onSignIn,
}: {
  copy?: Partial<LoginCopy>;
  onSignIn?: () => void;
} = {}) {
  const messages = { ...DEFAULT_COPY, ...copy };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        // The site's own copy, ALWAYS — never the server's message. Better
        // Auth distinguishes an unverified account (403 EMAIL_NOT_VERIFIED)
        // from bad credentials (401), and echoing that told an anonymous
        // visitor whether an address has an account here. On a roster-backed
        // neighbourhood site that is a membership disclosure, so every failure
        // reads the same and the copy tells an unverified user what to do
        // without confirming which case they hit.
        setError(messages.signInFailed);
        return;
      }
      onSignIn?.();
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setError('');
    setInfo('');
    if (!email) {
      setError(messages.resetNeedsEmail);
      return;
    }
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    if (result.error) {
      // Same rule as sign-in: our copy, not the server's.
      setError(messages.resetFailed);
    } else {
      setInfo(messages.resetSent);
    }
  }

  return {
    email,
    setEmail,
    password,
    setPassword,
    error,
    info,
    busy,
    handleSubmit,
    handleReset,
  };
}
