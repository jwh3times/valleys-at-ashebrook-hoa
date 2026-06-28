import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { getFirebaseAuth } from '../../lib/firebase';
import { checkIsAdmin } from '../../lib/admin';

export interface AuthState {
  loading: boolean;
  user: User | null;
  isAdmin: boolean;
}

/** Tracks the signed-in Firebase user and whether they are a board admin. */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    isAdmin: false,
  });

  useEffect(() => {
    const unsub = onAuthStateChanged(getFirebaseAuth(), async (user) => {
      if (!user) {
        setState({ loading: false, user: null, isAdmin: false });
        return;
      }
      let isAdmin = false;
      try {
        isAdmin = await checkIsAdmin(user.uid);
      } catch {
        isAdmin = false;
      }
      setState({ loading: false, user, isAdmin });
    });
    return () => unsub();
  }, []);

  return state;
}
