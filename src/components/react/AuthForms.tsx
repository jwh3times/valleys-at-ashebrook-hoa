import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await authClient.signUp.email({ email, password, name });
    setMsg(
      error
        ? (error.message ?? 'Error')
        : 'Check your email to verify your account, then sign in.',
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full name"
        required
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password (10+ chars)"
        required
        minLength={10}
      />
      <button type="submit">Create account</button>
      {msg && <p>{msg}</p>}
    </form>
  );
}

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await authClient.signIn.email({ email, password });
    if (error) setMsg(error.message ?? 'Sign-in failed');
    else window.location.href = '/';
  }
  async function onReset() {
    if (!email) {
      setMsg('Enter your email first, then click reset.');
      return;
    }
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setMsg(
      error
        ? (error.message ?? 'Could not send reset email.')
        : 'If that email exists, a reset link is on its way.',
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        required
      />
      <button type="submit">Sign in</button>
      <button type="button" onClick={onReset}>
        Forgot password?
      </button>
      {msg && <p>{msg}</p>}
    </form>
  );
}

function getResetParams() {
  if (typeof window === 'undefined') return { token: '', error: '' };
  const params = new URLSearchParams(window.location.search);
  return {
    token: params.get('token') ?? '',
    error: params.get('error') ?? '',
  };
}

export function ResetPasswordForm() {
  const [{ token, error: linkError }] = useState(getResetParams);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState<'idle' | 'error' | 'success'>('idle');
  const [busy, setBusy] = useState(false);

  const invalidLink = !token || linkError === 'INVALID_TOKEN';
  const invalidMessage =
    linkError === 'INVALID_TOKEN'
      ? 'This reset link is invalid or has expired. Request a new one from the sign-in page.'
      : 'This reset link is missing its token. Request a new password reset from the sign-in page.';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('idle');
    setMsg('');

    if (invalidLink) {
      setStatus('error');
      setMsg(invalidMessage);
      return;
    }
    if (password.length < 10) {
      setStatus('error');
      setMsg('Password must be at least 10 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setStatus('error');
      setMsg('Passwords do not match.');
      return;
    }

    const resetFailed = () => {
      setStatus('error');
      setMsg(
        'Could not reset your password. Request a new link and try again.',
      );
    };

    setBusy(true);
    try {
      const { error } = await authClient.resetPassword({
        newPassword: password,
        token,
      });

      if (error) {
        resetFailed();
        return;
      }
    } catch {
      resetFailed();
      return;
    } finally {
      setBusy(false);
    }

    setStatus('success');
    setMsg('Password updated. You can now sign in with your new password.');
  }

  if (invalidLink) {
    return (
      <div>
        <div className="form-message form-message--error">{invalidMessage}</div>
        <p>
          <a href="/login">Request a new reset link</a>
        </p>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div>
        <div className="form-message form-message--success">{msg}</div>
        <p>
          <a href="/login">Sign in</a>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="form-stack">
      {msg && (
        <div
          className={`form-message form-message--${
            status === 'error' ? 'error' : 'success'
          }`}
        >
          {msg}
        </div>
      )}
      <div className="field">
        <label htmlFor="new-password">New password</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={10}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="confirm-password">Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={10}
          required
        />
      </div>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'Updating...' : 'Set password'}
      </button>
    </form>
  );
}

export function VerifyPropertyForm() {
  const [address, setAddress] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'request' | 'confirm' | 'done'>('request');
  const [msg, setMsg] = useState('');
  async function request(e: React.FormEvent) {
    e.preventDefault();
    const turnstileToken = window.turnstileToken;
    if (!turnstileToken) {
      setMsg('Complete the captcha before requesting a code.');
      return;
    }

    try {
      const res = await fetch('/api/verify/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          channel,
          turnstileToken,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        queued?: boolean;
        rateLimited?: boolean;
        message?: string;
      };
      if (res.status === 429 || data.rateLimited) {
        setMsg(data.message ?? 'Too many requests. Please wait and try again.');
        return;
      }
      if (data.queued)
        setMsg(
          "Sent for manual review — you'll get a confirmation once your account is approved.",
        );
      else if (data.ok) {
        setMsg('Code sent — check your phone/email.');
        setStage('confirm');
      } else if (res.status === 400)
        setMsg(
          data.message ??
            'Could not validate the captcha. Complete it again and retry.',
        );
      else
        setMsg(
          'Could not start verification. Check the address and try again.',
        );
    } finally {
      // The Turnstile token is single-use; reset the widget so a retry (after a
      // rate-limit/error) gets a fresh token instead of failing "Bad captcha".
      if (window.turnstile) window.turnstile.reset();
      window.turnstileToken = undefined;
    }
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/verify/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      // A full navigation to the homeowner surface re-resolves the role in
      // middleware, so the confirmation link doubles as the session refresh.
      setStage('done');
      setMsg('Verified! You now have homeowner access.');
    } else {
      setMsg('Code invalid or expired.');
    }
  }
  if (stage === 'done')
    return (
      <div>
        <p>{msg}</p>
        <p>
          <a href="/documents">View resident documents →</a>
        </p>
      </div>
    );
  return stage === 'request' ? (
    <form onSubmit={request}>
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Your property address"
        required
      />
      <select
        value={channel}
        onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}
      >
        <option value="email">Email me the code</option>
        <option value="sms">Text me the code</option>
      </select>
      <button type="submit">Send code</button>
      {msg && <p>{msg}</p>}
    </form>
  ) : (
    <form onSubmit={confirm}>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="6-digit code"
        required
      />
      <button type="submit">Verify</button>
      {msg && <p>{msg}</p>}
    </form>
  );
}
