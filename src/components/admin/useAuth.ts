import { authClient } from '../../lib/auth-client';

/** Shape returned by useAuth for consuming components. */
export interface AuthState {
  loading: boolean;
  user: { email?: string | null; [key: string]: unknown } | null;
  isAdmin: boolean;
}

/** Tracks the Better Auth session and whether the user has the board role. */
export function useAuth(): AuthState {
  const { data, isPending } = authClient.useSession();
  const role = (data?.user as { role?: string } | undefined)?.role ?? 'visitor';
  return {
    loading: isPending,
    user: data?.user ?? null,
    isAdmin: role === 'board',
  };
}
