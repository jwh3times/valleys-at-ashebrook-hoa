import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { lots } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(lots);
});

function propRow(id: string, addressNormalized: string) {
  const now = new Date();
  return {
    id,
    address: addressNormalized.toUpperCase(),
    addressNormalized,
    unit: null,
    status: 'active' as const,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('D1 schema constraints', () => {
  it('rejects a second property with the same normalized address', async () => {
    const db = getDb(env);
    await db.insert(lots).values(propRow('p1', '1 main st'));
    await expect(
      db.insert(lots).values(propRow('p2', '1 main st')),
    ).rejects.toThrow();
  });
});
