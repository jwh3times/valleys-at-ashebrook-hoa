// One-time bootstrap: create the FIRST board account. Run via wrangler dev / a temporary
// admin route with the Worker bindings available, providing BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME.
import { eq } from 'drizzle-orm';
import { createAuth } from '../src/server/auth';
import { getDb } from '../src/server/db/client';
import { users } from '../src/server/db/schema';

export async function seedBoard(
  env: Env,
  email: string,
  password: string,
  name: string,
): Promise<string> {
  const auth = createAuth(env);
  const created = await auth.api.signUpEmail({ body: { email, password, name } });
  const userId = created.user.id;
  // No admin exists yet → set role + mark verified directly (trusted bootstrap, not self-service).
  await getDb(env).update(users).set({ role: 'board', emailVerified: true }).where(eq(users.id, userId));
  return userId;
}
