import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { lots } from '../db/schema';
import { normalizeAddress } from './normalize';

export { normalizeAddress };

export async function findActivePropertyByAddress(db: Db, address: string) {
  const norm = normalizeAddress(address);
  const [property] = await db
    .select()
    .from(lots)
    .where(and(eq(lots.addressNormalized, norm), eq(lots.status, 'active')));
  return property ?? null;
}
