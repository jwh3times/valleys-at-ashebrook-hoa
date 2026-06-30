// One-time bootstrap: create the FIRST board account. Run via wrangler dev / a temporary
// admin route with the Worker bindings available, providing BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME.
import { eq } from 'drizzle-orm';
import { createAuth } from '../src/server/auth';
import { getDb } from '../src/server/db/client';
import { users } from '../src/server/db/schema';

export async function seedBoard(env: Env, email: string, password: string, name: string): Promise<string> {
  if (!email || !password || !name) throw new Error('seedBoard requires email, password, and name');
  const auth = createAuth(env);
  const created = await auth.api.signUpEmail({ body: { email, password, name } });
  const userId = created.user.id;
  try {
    await getDb(env).update(users).set({ role: 'board', emailVerified: true }).where(eq(users.id, userId));
  } catch (err) {
    // Roll back the partially-created account so the operator can retry cleanly.
    await getDb(env).delete(users).where(eq(users.id, userId));
    throw err;
  }
  return userId;
}
