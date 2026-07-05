import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    try {
      await authClient.signOut();
    } finally {
      // Full navigation so the SSR chrome re-renders as signed-out.
      window.location.assign('/');
    }
  }
  return (
    <button
      type="button"
      className="nav-login"
      onClick={onClick}
      disabled={busy}
    >
      Sign out
    </button>
  );
}
