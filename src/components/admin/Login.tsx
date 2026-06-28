import { useState, type FormEvent } from 'react';
import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { getFirebaseAuth } from '../../lib/firebase';

export default function Login() {
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
      await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
    } catch {
      setError('Incorrect email or password. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setError('');
    setInfo('');
    if (!email) {
      setError('Enter your email above first, then click “Forgot password”.');
      return;
    }
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email);
      setInfo('Password reset email sent. Check your inbox.');
    } catch {
      setError('Could not send reset email. Check the address and try again.');
    }
  }

  return (
    <div className="login-box card">
      <h1 style={{ marginTop: 0 }}>Board Login</h1>
      <p className="muted">
        For HOA board members only. Sign in to manage announcements, documents,
        and dues.
      </p>
      {error && <div className="form-message form-message--error">{error}</div>}
      {info && <div className="form-message form-message--success">{info}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          className="btn btn--outline btn--small"
          style={{ marginLeft: '0.5rem' }}
          onClick={handleReset}
        >
          Forgot password
        </button>
      </form>
    </div>
  );
}
