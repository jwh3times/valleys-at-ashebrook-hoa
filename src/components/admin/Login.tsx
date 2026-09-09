import { useLoginForm } from '../react/useLoginForm';

export default function Login() {
  const {
    email,
    setEmail,
    password,
    setPassword,
    error,
    info,
    busy,
    handleSubmit,
    handleReset,
  } = useLoginForm({
    copy: {
      // Uniform by design, like the public form: one answer whether the
      // password was wrong or the account is real but unverified.
      signInFailed:
        'Incorrect email or password — or an email address you have not confirmed yet. Check the link from your sign-up email and try again.',
      resetNeedsEmail:
        'Enter your email above first, then click "Forgot password".',
      resetFailed:
        'Could not send reset email. Check the address and try again.',
      resetSent: 'Password reset email sent. Check your inbox.',
    },
  });

  return (
    <div className="admin-login">
      <span
        className="admin-login__plat admin-login__plat--a"
        aria-hidden="true"
      />
      <span
        className="admin-login__plat admin-login__plat--b"
        aria-hidden="true"
      />
      <div className="admin-login__inner">
        <div className="admin-login__brand">
          <span className="mark mark--lg mark--inverse" aria-hidden="true">
            <i></i>
          </span>
          <span>Valleys at Ashebrook</span>
        </div>

        <div className="admin-login__card">
          <h1>Board Login</h1>
          <p>Sign in to manage the community site.</p>

          {error && (
            <div className="form-message form-message--error">{error}</div>
          )}
          {info && (
            <div className="form-message form-message--success">{info}</div>
          )}

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
            <div className="field" style={{ marginBottom: '8px' }}>
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button
              className="btn"
              type="submit"
              disabled={busy}
              style={{ width: '100%', marginTop: '4px' }}
            >
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <div className="admin-login__row">
            <button
              type="button"
              className="linklike linklike--muted"
              onClick={handleReset}
            >
              Forgot password?
            </button>
            <a className="linklike" href="/">
              ← Back to site
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
