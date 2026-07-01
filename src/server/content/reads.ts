import { inArray, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { announcements, documents } from '../db/schema';
import { visibleTiers } from './visibility';
import type { Role } from '../authz/guards';

export async function fetchDocumentsFor(env: Env, role: Role) {
  return getDb(env)
    .select()
    .from(documents)
    .where(inArray(documents.visibility, visibleTiers(role)));
}

export async function fetchAnnouncementsFor(
  env: Env,
  role: Role,
  limit?: number,
) {
  const rows = await getDb(env)
    .select()
    .from(announcements)
    .where(inArray(announcements.visibility, visibleTiers(role)))
    .orderBy(desc(announcements.pinned), desc(announcements.date));
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}
