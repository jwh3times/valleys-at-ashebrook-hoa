import { useState, type FormEvent } from 'react';
import { authClient } from '../../lib/auth-client';

type LoginCopy = {
  signInFailed: string;
  resetNeedsEmail: string;
  resetFailed: string;
  resetSent: string;
};

const DEFAULT_COPY: LoginCopy = {
  signInFailed: 'Sign-in failed',
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
        setError(result.error.message ?? messages.signInFailed);
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
      setError(result.error.message ?? messages.resetFailed);
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
