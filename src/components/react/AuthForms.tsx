import { useState } from 'react';
import { authClient } from '../../lib/auth-client';
import { useLoginForm } from './useLoginForm';

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
  const {
    email,
    setEmail,
    password,
    setPassword,
    error,
    info,
    handleSubmit,
    handleReset,
  } = useLoginForm({ onSignIn: () => (window.location.href = '/') });
  const msg = error || info;
  return (
    <form onSubmit={handleSubmit}>
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
      <button type="button" onClick={handleReset}>
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

// Every gate the server can fail before it reaches the roster (malformed
// captcha, an unauthenticated caller, the maintenance freeze) keeps its own
// status code; everything past those gates — matched or not, sent or not —
// answers with the same 200 body, so this component never branches on
// whether anything actually matched or was sent. See #219 D2.
const DEFAULT_REQUEST_ERROR =
  'Could not start verification. Check your information and try again.';
const DEFAULT_REVIEW_ERROR = 'Could not send your request. Please try again.';

export function VerifyPropertyForm() {
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'request' | 'confirm' | 'done'>('request');
  const [msg, setMsg] = useState('');
  const [hasRequested, setHasRequested] = useState(false);
  const [reviewMsg, setReviewMsg] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    const turnstileToken = window.turnstileToken;
    if (!turnstileToken) {
      setMsg('Complete the captcha before requesting a code.');
      return;
    }

    setHasRequested(true);
    try {
      const res = await fetch('/api/verify/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          name,
          channel,
          turnstileToken,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (res.status === 200) {
        // The uniform response never says whether a code went out, so the
        // stage always advances — the message itself is the only signal the
        // caller ever gets.
        setMsg(
          data.message ??
            'If the information matches our records, a code has been sent.',
        );
        setStage('confirm');
      } else if (res.status === 400) {
        setMsg(
          data.message ??
            'Could not validate the captcha. Complete it again and retry.',
        );
      } else if (res.status === 401) {
        setMsg('Sign in and try again.');
      } else if (res.status === 503) {
        setMsg(
          'Verification is temporarily unavailable. Please try again later.',
        );
      } else {
        setMsg(DEFAULT_REQUEST_ERROR);
      }
    } finally {
      // The Turnstile token is single-use; reset the widget so a retry (after
      // an error) gets a fresh token instead of failing "Bad captcha".
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

  async function askForReview() {
    setReviewBusy(true);
    try {
      const res = await fetch('/api/verify/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, name }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      setReviewMsg(data.message ?? DEFAULT_REVIEW_ERROR);
    } catch {
      setReviewMsg(DEFAULT_REVIEW_ERROR);
    } finally {
      setReviewBusy(false);
    }
  }

  const showReviewAction = stage === 'confirm' || hasRequested;
  const reviewAction = showReviewAction && (
    <div>
      <button type="button" onClick={askForReview} disabled={reviewBusy}>
        Didn't get a code? Ask the board to review
      </button>
      {reviewMsg && <p>{reviewMsg}</p>}
    </div>
  );

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
    <>
      <form onSubmit={request}>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Your property address"
          required
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your full name"
          autoComplete="name"
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
      {reviewAction}
    </>
  ) : (
    <>
      <form onSubmit={confirm}>
        {msg && <p>{msg}</p>}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="6-digit code"
          required
        />
        <button type="submit">Verify</button>
      </form>
      {reviewAction}
    </>
  );
}
