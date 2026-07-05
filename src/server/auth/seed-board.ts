import { eq, sql } from 'drizzle-orm';
import { createAuth } from './index';
import { getDb } from '../db/client';
import { users } from '../db/schema';
import { timingSafeEqual } from '../authz/timing-safe';

/**
 * Create the FIRST board account. `board`/`emailVerified` are written directly
 * (they can't be set through the self-service flow). Invoked by the bootstrap
 * endpoint below, or re-exported for CLI/muscle-memory use via scripts/seed-board.ts.
 */
export async function seedBoard(
  env: Env,
  email: string,
  password: string,
  name: string,
): Promise<string> {
  if (!email || !password || !name)
    throw new Error('seedBoard requires email, password, and name');
  const auth = createAuth(env);
  const created = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  const userId = created.user.id;
  try {
    await getDb(env)
      .update(users)
      .set({ role: 'board', emailVerified: true })
      .where(eq(users.id, userId));
  } catch (err) {
    // Roll back the partially-created account so the operator can retry cleanly.
    await getDb(env).delete(users).where(eq(users.id, userId));
    throw err;
  }
  return userId;
}

/**
 * Fail-closed first-board bootstrap. Replaces the old temporary-route runbook:
 * a permanent endpoint that is inert once any board account exists, so a
 * forgotten route can never become a standing role-escalation backdoor.
 *
 * Three independent guards, all required, checked in order:
 *  1. Self-disabling — refuse with 410 the moment a board account exists.
 *  2. Secret — constant-time match of `x-bootstrap-secret` against
 *     `env.BOOTSTRAP_SECRET`; a missing binding is treated as closed (403),
 *     never as "unset means open".
 *  3. Config — `BOARD_EMAIL`/`BOARD_PASSWORD`/`BOARD_NAME` must be set (400).
 */
export async function handleBootstrapBoard(
  env: Env,
  request: Request,
): Promise<Response> {
  const db = getDb(env);

  // 1. Primary guard: permanently inert on any bootstrapped site.
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, 'board'));
  if (n > 0)
    return new Response('A board account already exists.', { status: 410 });

  // 2. Secret gate (fail-closed).
  const provided = request.headers.get('x-bootstrap-secret');
  if (
    !env.BOOTSTRAP_SECRET ||
    !provided ||
    !timingSafeEqual(provided, env.BOOTSTRAP_SECRET)
  )
    return new Response('Forbidden', { status: 403 });

  // 3. Config gate.
  const { BOARD_EMAIL, BOARD_PASSWORD, BOARD_NAME } = env;
  if (!BOARD_EMAIL || !BOARD_PASSWORD || !BOARD_NAME)
    return new Response('Missing BOARD_EMAIL / BOARD_PASSWORD / BOARD_NAME.', {
      status: 400,
    });

  await seedBoard(env, BOARD_EMAIL, BOARD_PASSWORD, BOARD_NAME);
  return new Response(null, { status: 204 });
}
