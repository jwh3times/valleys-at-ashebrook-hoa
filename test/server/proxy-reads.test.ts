import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { proxies } from '../../src/server/db/schema';
import { fetchAdminProxies } from '../../src/server/content/reads';
import {
  truncateAll,
  seedProperty,
  seedOwner,
  seedMeeting,
  seedElection,
  proxyRow,
} from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(truncateAll);

describe('fetchAdminProxies', () => {
  it('returns every proxy with resolved names, newest first', async () => {
    await seedProperty('p1');
    await seedOwner('o1', 'p1');
    await seedOwner('o2', 'p1');
    await seedMeeting('m1');
    await seedElection('e1');
    const db = getDb(env);
    await db.insert(proxies).values(
      proxyRow('x1', {
        meetingId: 'm1',
        holderOwnerId: 'o2',
        createdAt: new Date('2026-01-01'),
      }),
    );
    await db.insert(proxies).values(
      proxyRow('x2', {
        electionId: 'e1',
        createdAt: new Date('2026-02-01'),
      }),
    );
    const rows = await fetchAdminProxies(env);
    expect(rows.map((r) => r.id)).toEqual(['x2', 'x1']);
    expect(rows[1]).toEqual({
      id: 'x1',
      propertyId: 'p1',
      address: 'p1 Ashebrook Lane',
      grantorOwnerId: 'o1',
      grantorName: 'Owner o1',
      holderName: 'Jane Q. Holder',
      holderOwnerId: 'o2',
      holderOwnerName: 'Owner o2',
      meetingId: 'm1',
      electionId: null,
    });
    expect(rows[0].holderOwnerName).toBeNull();
    expect(rows[0].electionId).toBe('e1');
  });

  it('returns an empty list when there are no proxies', async () => {
    expect(await fetchAdminProxies(env)).toEqual([]);
  });
});
