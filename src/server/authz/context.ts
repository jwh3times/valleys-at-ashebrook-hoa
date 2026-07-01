import { and, eq } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import { owners, userPropertyLinks, users } from '../db/schema';
import type { AuthContext, Role } from './guards';

const VALID_ROLES = new Set<string>(['visitor', 'homeowner', 'board']);

export async function getAuthContext(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const auth = createAuth(env);
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  const db = getDb(env);
  const [roleRows, links] = await Promise.all([
    db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, result.user.id)),
    db
      .select({ ownerId: userPropertyLinks.ownerId })
      .from(userPropertyLinks)
      .innerJoin(owners, eq(userPropertyLinks.ownerId, owners.id))
      .where(
        and(
          eq(userPropertyLinks.userId, result.user.id),
          eq(owners.status, 'active'),
        ),
      ),
  ]);
  const rawRole = roleRows[0]?.role ?? null;
  const role: Role =
    rawRole && VALID_ROLES.has(rawRole) ? (rawRole as Role) : 'visitor';
  return {
    userId: result.user.id,
    role,
    ownerIds: links.map((l) => l.ownerId),
  };
}
