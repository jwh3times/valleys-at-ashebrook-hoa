import { useEffect, useState } from 'react';
import { authClient } from '../../lib/auth-client';

/** Shape returned by useAuth for consuming components. */
export interface AuthState {
  loading: boolean;
  user: { email?: string | null; [key: string]: unknown } | null;
  isAdmin: boolean;
}

/**
 * Tracks the Better Auth session and whether the caller holds the `board`
 * capability.
 *
 * The capability comes from `GET /api/me`, which reads the same
 * `AuthContext` every admin route gates on — never from the session's `role`,
 * which is only the write-behind mirror of an Access Grant (#212). Fails
 * closed: an unreadable context, a pending read, or an answer that belongs to
 * a previous session or account all show the non-admin view. The routes stay
 * the authority either way.
 */
export function useAuth(): AuthState {
  const { data, isPending } = authClient.useSession();
  const userId = (data?.user as { id?: string } | undefined)?.id ?? null;
  // Keyed on the session, not only the account: signing out and back in as
  // the same account must re-read, or a grant added (or revoked) in between
  // would show the previous session's answer until the new one lands.
  const key = userId
    ? ((data as { session?: { id?: string } } | null)?.session?.id ?? userId)
    : null;
  const [access, setAccess] = useState<{
    key: string;
    isAdmin: boolean;
  } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    async function load(forKey: string) {
      let isAdmin = false;
      try {
        const res = await fetch('/api/me', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as { capabilities?: unknown };
          isAdmin =
            Array.isArray(body.capabilities) &&
            body.capabilities.includes('board');
        }
      } catch {
        // Fail closed: the non-admin view.
      }
      if (!cancelled) setAccess({ key: forKey, isAdmin });
    }
    void load(key);
    return () => {
      cancelled = true;
    };
  }, [key]);

  const resolved = key !== null && access?.key === key;
  return {
    loading: isPending || (key !== null && !resolved),
    user: data?.user ?? null,
    isAdmin: resolved ? access.isAdmin : false,
  };
}
