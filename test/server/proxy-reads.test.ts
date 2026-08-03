import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  proxies,
  properties,
  owners,
  meetings,
  elections,
} from '../../src/server/db/schema';
import { fetchAdminProxies } from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(proxies);
  await db.delete(elections);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

async function seedProperty(id: string) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Main St`,
      addressNormalized: `${id} main st`,
      unit: null,
      status: 'active',
      voteWeight: 1,
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOwner(id: string, propertyId: string) {
  await getDb(env)
    .insert(owners)
    .values({
      id,
      propertyId,
      fullName: `Owner ${id}`,
      phone: null,
      email: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedMeeting(id: string) {
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2026-03-01',
      title: `Meeting ${id}`,
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
}

async function seedElection(id: string, meetingId: string | null = null) {
  await getDb(env)
    .insert(elections)
    .values({
      id,
      meetingId,
      title: `Election ${id}`,
      seats: 2,
      electionDate: '2026-03-01',
      source: 'recorded',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
}

function proxyRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    propertyId: 'p1',
    grantorOwnerId: 'o1',
    holderName: 'Jane Q. Holder',
    holderOwnerId: null,
    meetingId: null,
    electionId: null,
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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
      address: 'p1 Main St',
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
