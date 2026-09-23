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
import { GET, POST } from '../../src/pages/api/admin/roster-lots';
import { pauseNextBatch } from './fixtures';

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

/**
 * Recording and editing a Lot on the party roster (#212), replacing the
 * legacy Homes & owners panel's writes. The address is personal enough to be
 * masked by the assistant's pseudonymizer, so the ledger records only that it
 * changed (`lot_address`); the vote weight is a non-personal scalar and is
 * recorded old-and-new.
 */
async function eventsOfKind(kind: string) {
  return getDb(env).all<{ id: string; reason_code: string }>(
    sql`SELECT e.id, r.reason_code FROM audit_events e
        JOIN roster_changes r ON r.event_id = e.id
        WHERE e.event_kind = ${kind}`,
  );
}

async function lotSubjectsOf(eventId: string) {
  return getDb(env).all<{ lot_id: string; role: string }>(
    sql`SELECT lot_id, role FROM roster_change_subjects WHERE event_id = ${eventId}`,
  );
}

async function sensitiveOf(eventId: string) {
  return (
    await getDb(env).all<{ field_category: string }>(
      sql`SELECT field_category FROM audit_sensitive_field_changes WHERE event_id = ${eventId}`,
    )
  ).map((r) => r.field_category);
}

async function scalarsOf(eventId: string) {
  return getDb(env).all<{
    field_key: string;
    old_integer: number | null;
    new_integer: number | null;
  }>(
    sql`SELECT field_key, old_integer, new_integer FROM audit_scalar_changes WHERE event_id = ${eventId}`,
  );
}

describe('create', () => {
  it('records a live lot with its weight and an audited change', async () => {
    const res = await POST(
      req({
        action: 'create',
        address: '7 Oak Lane',
        unit: 'B',
        voteWeight: 2,
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [lot] = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, id));
    expect(lot.address).toBe('7 Oak Lane');
    expect(lot.addressNormalized).toBe('7 oak lane');
    expect(lot.unit).toBe('B');
    expect(lot.voteWeight).toBe(2);
    expect(lot.status).toBe('active');
    expect(lot.retiredAt).toBeNull();

    const [event] = await eventsOfKind('lot_recorded');
    expect(event.reason_code).toBe('board_recorded');
    expect(await lotSubjectsOf(event.id)).toEqual([
      { lot_id: id, role: 'created' },
    ]);
    expect(await sensitiveOf(event.id)).toEqual(['lot_address']);
    expect(await scalarsOf(event.id)).toEqual([
      { field_key: 'vote_weight', old_integer: null, new_integer: 2 },
    ]);
    expect(
      await getDb(env).all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('defaults the vote weight to 1', async () => {
    const res = await POST(req({ action: 'create', address: '8 Oak Lane' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [lot] = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, id));
    expect(lot.voteWeight).toBe(1);
  });

  it('409s an address already on the roster and records nothing', async () => {
    await seedLot('lot-1');
    const res = await POST(
      req({ action: 'create', address: 'LOT-1  Ashebrook Lane' }),
    );
    expect(res.status).toBe(409);
    expect(await eventsOfKind('lot_recorded')).toEqual([]);
  });

  it('refuses status and notes, which the new roster does not take here', async () => {
    const status = await POST(
      req({ action: 'create', address: '9 Oak Lane', status: 'inactive' }),
    );
    expect(status.status).toBe(400);
    expect(await status.text()).toBe(
      'status is set by retiring a lot, not here',
    );
    const notes = await POST(
      req({ action: 'create', address: '9 Oak Lane', notes: 'x' }),
    );
    expect(notes.status).toBe(400);
    expect(await notes.text()).toBe('notes are not recorded on the roster');
    expect(await getDb(env).select().from(properties)).toEqual([]);
  });

  it('400s a missing address and a weight below 1, zero included', async () => {
    const missing = await POST(req({ action: 'create' }));
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe('address is required');
    for (const voteWeight of [0, -1]) {
      const res = await POST(
        req({ action: 'create', address: 'x', voteWeight }),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(
        'voteWeight must be a whole number of 1 or more',
      );
    }
    expect(await getDb(env).select().from(properties)).toEqual([]);
  });
});

describe('update', () => {
  it('changes address, unit, and weight with one audited change', async () => {
    await seedLot('lot-1');
    const res = await POST(
      req({
        action: 'update',
        lotId: 'lot-1',
        address: '12 Elm Court',
        unit: '2',
        voteWeight: 3,
      }),
    );
    expect(res.status).toBe(204);

    const [lot] = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, 'lot-1'));
    expect(lot.address).toBe('12 Elm Court');
    expect(lot.addressNormalized).toBe('12 elm court');
    expect(lot.unit).toBe('2');
    expect(lot.voteWeight).toBe(3);

    const [event] = await eventsOfKind('lot_updated');
    expect(event.reason_code).toBe('board_recorded');
    expect(await lotSubjectsOf(event.id)).toEqual([
      { lot_id: 'lot-1', role: 'primary' },
    ]);
    expect(await sensitiveOf(event.id)).toEqual(['lot_address']);
    expect(await scalarsOf(event.id)).toEqual([
      { field_key: 'vote_weight', old_integer: 1, new_integer: 3 },
    ]);
    expect(
      await getDb(env).all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('records an address-only change as a correction, not a decision', async () => {
    await seedLot('lot-1');
    const res = await POST(
      req({ action: 'update', lotId: 'lot-1', address: '3 Fixed Typo Rd' }),
    );
    expect(res.status).toBe(204);
    const [event] = await eventsOfKind('lot_updated');
    expect(event.reason_code).toBe('recorded_in_error');
    expect(await sensitiveOf(event.id)).toEqual(['lot_address']);
    expect(await scalarsOf(event.id)).toEqual([]);
  });

  it('records a weight-only change without an address category', async () => {
    await seedLot('lot-1');
    const res = await POST(
      req({ action: 'update', lotId: 'lot-1', voteWeight: 4 }),
    );
    expect(res.status).toBe(204);
    const [event] = await eventsOfKind('lot_updated');
    expect(await sensitiveOf(event.id)).toEqual([]);
    expect(await scalarsOf(event.id)).toEqual([
      { field_key: 'vote_weight', old_integer: 1, new_integer: 4 },
    ]);
  });

  it('writes no ledger row when nothing changes', async () => {
    await seedLot('lot-1');
    const res = await POST(
      req({
        action: 'update',
        lotId: 'lot-1',
        address: 'lot-1 Ashebrook Lane',
        voteWeight: 1,
      }),
    );
    expect(res.status).toBe(204);
    expect(await eventsOfKind('lot_updated')).toEqual([]);
  });

  it('409s a retired lot and 404s an unknown one', async () => {
    await seedLot('lot-1');
    await POST(req({ action: 'retire', lotId: 'lot-1' }));
    const retired = await POST(
      req({ action: 'update', lotId: 'lot-1', voteWeight: 2 }),
    );
    expect(retired.status).toBe(409);
    const [lot] = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, 'lot-1'));
    expect(lot.voteWeight).toBe(1);

    const unknown = await POST(
      req({ action: 'update', lotId: 'nope', voteWeight: 2 }),
    );
    expect(unknown.status).toBe(404);
  });

  it('409s an address another lot already has', async () => {
    await seedLot('lot-1');
    await seedLot('lot-2');
    const res = await POST(
      req({
        action: 'update',
        lotId: 'lot-2',
        address: 'lot-1 Ashebrook Lane',
      }),
    );
    expect(res.status).toBe(409);
    expect(await eventsOfKind('lot_updated')).toEqual([]);
  });

  it('refuses status and notes', async () => {
    await seedLot('lot-1');
    const status = await POST(
      req({ action: 'update', lotId: 'lot-1', status: 'inactive' }),
    );
    expect(status.status).toBe(400);
    expect(await status.text()).toBe(
      'status is set by retiring a lot, not here',
    );
    const notes = await POST(
      req({ action: 'update', lotId: 'lot-1', notes: 'x' }),
    );
    expect(notes.status).toBe(400);
    expect(await notes.text()).toBe('notes are not recorded on the roster');
  });
});

describe('update under a race', () => {
  it('records nothing when an identical edit lands first in the same second', async () => {
    await seedLot('lot-1');
    // The route stamps `updated_at` in seconds; pin the clock so the
    // competing write lands in exactly that second — the case the post-state
    // guard alone cannot tell apart from this command's own write.
    const T = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T);
    const pause = pauseNextBatch();
    try {
      const pending = POST(
        req({ action: 'update', lotId: 'lot-1', voteWeight: 3 }),
      );
      await pause.reached;
      await env.DATABASE.prepare(
        'UPDATE properties SET vote_weight = 3, updated_at = ? WHERE id = ?',
      )
        .bind(Math.floor(T / 1000), 'lot-1')
        .run();
      pause.release();
      const res = await pending;
      expect(res.status).toBe(409);
    } finally {
      pause.restore();
      clock.mockRestore();
    }
    expect(await eventsOfKind('lot_updated')).toEqual([]);
  });

  it('409s when the lot changed since the editor loaded it', async () => {
    await seedLot('lot-1');
    await POST(req({ action: 'update', lotId: 'lot-1', voteWeight: 2 }));
    const res = await POST(
      req({
        action: 'update',
        lotId: 'lot-1',
        address: '1 Renamed Way',
        voteWeight: 1,
        expected: {
          address: 'lot-1 Ashebrook Lane',
          unit: null,
          voteWeight: 1,
        },
      }),
    );
    expect(res.status).toBe(409);
    const [lot] = await getDb(env)
      .select()
      .from(properties)
      .where(eq(properties.id, 'lot-1'));
    expect(lot.voteWeight).toBe(2);
    expect(lot.address).toBe('lot-1 Ashebrook Lane');
  });
});

describe('GET', () => {
  it('lists every lot with only the fields the admin panels use', async () => {
    await seedLot('lot-b');
    await seedLot('lot-a');
    await POST(req({ action: 'retire', lotId: 'lot-b' }));
    await getDb(env)
      .update(properties)
      .set({ notes: 'legacy note', unit: '2' })
      .where(eq(properties.id, 'lot-a'));

    const res = await GET({
      request: new Request('http://localhost/api/admin/roster-lots'),
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: 'lot-a',
        address: 'lot-a Ashebrook Lane',
        unit: '2',
        status: 'active',
        voteWeight: 1,
      },
      {
        id: 'lot-b',
        address: 'lot-b Ashebrook Lane',
        unit: null,
        status: 'inactive',
        voteWeight: 1,
      },
    ]);
  });
});
