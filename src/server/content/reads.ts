import { inArray, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { announcements, documents } from '../db/schema';
import { visibleTiers } from './visibility';
import type { Role } from '../authz/guards';

export async function fetchDocumentsFor(env: Env, role: Role) {
  // Project only the DocumentItem contract columns. A bare .select() would ship
  // internal storage metadata (r2Key, filename, sizeBytes, contentType) to every
  // caller; the download path re-reads the row server-side, so the public list
  // never needs them.
  return getDb(env)
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(inArray(documents.visibility, visibleTiers(role)));
}

export async function fetchAdminDocuments(env: Env) {
  // Board-only: includes rag_status (searchability), which the public
  // DocumentItem projection deliberately omits. All tiers, newest first.
  return getDb(env)
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
      updatedAt: documents.updatedAt,
      ragStatus: documents.ragStatus,
      filename: documents.filename,
    })
    .from(documents)
    .orderBy(desc(documents.updatedAt));
}

export async function fetchAnnouncementsFor(
  env: Env,
  role: Role,
  limit?: number,
) {
  const query = getDb(env)
    .select()
    .from(announcements)
    .where(inArray(announcements.visibility, visibleTiers(role)))
    .orderBy(desc(announcements.pinned), desc(announcements.date));
  return typeof limit === 'number' ? query.limit(limit) : query;
}
