import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { properties } from '../db/schema';
import { normalizeAddress } from './normalize';

export { normalizeAddress };

export async function findActivePropertyByAddress(db: Db, address: string) {
  const norm = normalizeAddress(address);
  const [property] = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.addressNormalized, norm),
        eq(properties.status, 'active'),
      ),
    );
  return property ?? null;
}
