import { and, eq } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import { properties, userPropertyLinks } from '../db/schema';
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
  const links = await db
    .select({ propertyId: userPropertyLinks.propertyId })
    .from(userPropertyLinks)
    .innerJoin(properties, eq(userPropertyLinks.propertyId, properties.id))
    .where(
      and(
        eq(userPropertyLinks.userId, result.user.id),
        eq(properties.status, 'active'),
      ),
    );
  const rawRole = (result.user as { role?: unknown }).role;
  const role: Role =
    typeof rawRole === 'string' && VALID_ROLES.has(rawRole)
      ? (rawRole as Role)
      : 'visitor';
  return {
    userId: result.user.id,
    role,
    propertyIds: links.map((l) => l.propertyId),
  };
}
