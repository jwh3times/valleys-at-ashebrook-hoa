import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { owners } from '../db/schema';

export function normalizeAddress(raw: string): string {
  return raw.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

export async function findActiveOwnerByAddress(db: Db, address: string) {
  const norm = normalizeAddress(address);
  const [owner] = await db
    .select()
    .from(owners)
    .where(and(eq(owners.addressNormalized, norm), eq(owners.status, 'active')));
  return owner ?? null;
}
