import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  elections,
  electionEligibility,
} from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  ownerships,
  boardServiceTerms,
} from '../../src/server/db/roster-schema';
import { POST } from '../../src/pages/api/admin/roster-lots';

/**
 * #218's Lot retirement (#205): ownerships end as caused Roster Changes in
 * the same batch, the two refusals hold (a live qualifying term; an open
 * frozen snapshot), the legacy `status` column stays in lockstep so the two
 * models cannot diverge pre-flip, and an erroneous retirement is corrected
 * without resurrecting the ownerships it ended.
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    (
      await importActual<typeof import('../../src/server/authz/context')>()
    ).legacyAuthContext('board-1', 'board', []),
}));

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const CLEAR = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'board_service_change_subjects',
  'roster_change_subjects',
  'board_service_changes',
  'roster_changes',
  'access_events',
  'audit_events',
  'board_service_terms',
  'ownerships',
  'people',
  'parties',
  'election_eligibility',
  'elections',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      await db.run(
        sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
      );
    }
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw('DELETE FROM properties'));
  await db.run(sql.raw('DELETE FROM users'));
  const now = new Date();
  await db.insert(users).values({
    id: 'board-1',
    name: 'board-1',
    email: 'board-1@example.test',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
});

async function seedLot(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Ashebrook Lane`,
      addressNormalized: `${id} ashebrook lane`,
      status: 'active',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedPerson(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env)
    .insert(people)
    .values({
      partyId: id,
      partyKind: 'person',
      fullName: `Person ${id}`,
      nameNormalized: `person ${id}`,
      updatedAt: now,
    });
}

async function seedOwnership(id: string, ownerPartyId: string, lotId: string) {
  const now = new Date();
  await getDb(env).insert(ownerships).values({
    id,
    ownerPartyId,
    lotId,
    startDay: '2025-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

function req(body: unknown): never {
  return {
    request: new Request('http://localhost/api/admin/roster-lots', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as never;
}

describe('retire', () => {
  it('retires the lot, dual-writes status, and ends its ownerships as caused changes', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedPerson('per-2');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedOwnership('own-2', 'per-2', 'lot-1');

    const res = await POST(req({ action: 'retire', lotId: 'lot-1' }));
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [lot] = await db
      .select()
      .from(properties)
      .where(eq(properties.id, 'lot-1'));
    expect(lot.status).toBe('inactive');
    expect(lot.retiredAt).not.toBeNull();
    expect(lot.retiredDay).not.toBeNull();

    const owns = await db.select().from(ownerships);
    for (const own of owns) expect(own.endDay).not.toBeNull();

    const events = await db.all<{
      event_kind: string;
      correlation_sequence: number;
      actor_kind: string;
    }>(
      sql`SELECT event_kind, correlation_sequence, actor_kind FROM audit_events ORDER BY correlation_sequence`,
    );
    expect(events[0]).toMatchObject({
      event_kind: 'lot_retired',
      correlation_sequence: 0,
      actor_kind: 'account',
    });
    const caused = events.filter((e) => e.correlation_sequence > 0);
    expect(caused).toHaveLength(2);
    for (const e of caused)
      expect(e).toMatchObject({
        event_kind: 'ownership_ended',
        actor_kind: 'automatic',
      });

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('refuses while a live term names the lot as its qualifying lot', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    const now = new Date();
    await getDb(env).insert(boardServiceTerms).values({
      id: 'term-1',
      personId: 'per-1',
      qualifyingLotId: 'lot-1',
      startDay: '2026-01-01',
      scheduledEndDay: '2027-01-01',
      createdAt: now,
      updatedAt: now,
    });

    const res = await POST(req({ action: 'retire', lotId: 'lot-1' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('qualifying lot');
    const db = getDb(env);
    const [lot] = await db
      .select()
      .from(properties)
      .where(eq(properties.id, 'lot-1'));
    expect(lot.retiredAt).toBeNull();
  });

  it('refuses while an open occasion holds the lot in a frozen snapshot', async () => {
    await seedLot('lot-1');
    const now = new Date();
    await getDb(env).insert(elections).values({
      id: 'el-1',
      title: 'Open election',
      seats: 1,
      electionDate: '2026-08-20',
      source: 'conducted',
      status: 'open',
      visibility: 'public',
      createdBy: 'board-1',
      createdAt: now,
      updatedAt: now,
    });
    await getDb(env).insert(electionEligibility).values({
      electionId: 'el-1',
      propertyId: 'lot-1',
      weight: 1,
    });

    const res = await POST(req({ action: 'retire', lotId: 'lot-1' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('open occasion');
  });

  it('409s an already-retired lot and refuses a future effectiveDay', async () => {
    await seedLot('lot-1');
    const first = await POST(req({ action: 'retire', lotId: 'lot-1' }));
    expect(first.status).toBe(204);
    const second = await POST(req({ action: 'retire', lotId: 'lot-1' }));
    expect(second.status).toBe(409);

    await seedLot('lot-2');
    const future = await POST(
      req({ action: 'retire', lotId: 'lot-2', effectiveDay: '2030-01-01' }),
    );
    expect(future.status).toBe(400);
  });
});

describe('correctRetirement', () => {
  it('restores the lot without resurrecting the ownerships the retirement ended', async () => {
    await seedLot('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await POST(req({ action: 'retire', lotId: 'lot-1' }));

    const res = await POST(
      req({ action: 'correctRetirement', lotId: 'lot-1' }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [lot] = await db
      .select()
      .from(properties)
      .where(eq(properties.id, 'lot-1'));
    expect(lot.status).toBe('active');
    expect(lot.retiredAt).toBeNull();
    expect(lot.retiredDay).toBeNull();

    // The caused ownership end stands; restoring it is a separate ownership
    // void-and-recreate, never an implicit side effect of this correction.
    const [own] = await db
      .select()
      .from(ownerships)
      .where(eq(ownerships.id, 'own-1'));
    expect(own.endDay).not.toBeNull();

    const notRetired = await POST(
      req({ action: 'correctRetirement', lotId: 'lot-1' }),
    );
    expect(notRetired.status).toBe(409);
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });
});
