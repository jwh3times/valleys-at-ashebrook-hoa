import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../../server/authz/api-guards';
import { getDb } from '../../../../server/db/client';
import { driveConnection } from '../../../../server/db/schema';
import { users } from '../../../../server/db/auth-schema';
import { driveConfig, notConfigured } from '../../../../server/drive/config';

export const prerender = false;

/**
 * The Drive connection's state for the admin panel (#290 slice 2). Board
 * admins read it to know whether import is available; `canManage` tells the
 * panel whether to offer Connect/Reconnect/Disconnect, which only a System
 * Administrator may use. Never returns the credential.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!driveConfig(env)) return notConfigured();
  const ctx = await resolveAuthContext(locals, request, env);
  const canManage = ctx?.capabilities.has('systemAdmin') ?? false;

  const [row] = await getDb(env)
    .select({
      status: driveConnection.status,
      googleEmail: driveConnection.googleEmail,
      connectedBy: driveConnection.connectedBy,
      connectedByName: users.name,
      connectedAt: driveConnection.connectedAt,
      lastUsedAt: driveConnection.lastUsedAt,
      lastRefreshedAt: driveConnection.lastRefreshedAt,
      brokenAt: driveConnection.brokenAt,
    })
    .from(driveConnection)
    .leftJoin(users, eq(users.id, driveConnection.connectedBy))
    .where(eq(driveConnection.id, 1));
  if (!row)
    return Response.json({ configured: true, status: 'none', canManage });
  return Response.json({ configured: true, canManage, ...row });
};
