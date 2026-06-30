import { eq } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import { userPropertyLinks, users } from '../db/schema';
import type { AuthContext, Role } from './guards';

export async function getAuthContext(request: Request, env: Env): Promise<AuthContext | null> {
  const auth = createAuth(env);
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;
  const db = getDb(env);
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, result.user.id));
  const role = (row?.role as Role) ?? 'visitor';
  const links = await db
    .select({ ownerId: userPropertyLinks.ownerId })
    .from(userPropertyLinks)
    .where(eq(userPropertyLinks.userId, result.user.id));
  return { userId: result.user.id, role, ownerIds: links.map((l) => l.ownerId) };
}
