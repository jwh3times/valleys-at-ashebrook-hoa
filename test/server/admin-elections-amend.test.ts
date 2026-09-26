import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('b', 'board', []),
}));

import { POST } from '../../src/pages/api/admin/elections';
import { getDb } from '../../src/server/db/client';
import { ballots } from '../../src/server/db/schema';
import { auditEvents, reviewFlags } from '../../src/server/db/audit-schema';
import { eq } from 'drizzle-orm';
import { callerContext } from './caller-context';
import {
  req,
  truncateAll,
  seedElection,
  seedProperty,
  seedBallot,
  seedPerson,
  pauseNextBatch,
} from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await truncateAll();
  // `truncateAll` leaves `audit_events` alone on purpose — the ledger is
  // append-only. Flags are its children and may go; the seed below keeps its
  // event identifiers unique per call so the surviving ledger never collides.
  await getDb(env).delete(reviewFlags);
});

const url = 'http://localhost/api/admin/elections';

/** An instant well before the amendment, so a re-stamp is unmistakable. */
const originallyRecorded = new Date('2026-09-14T12:00:00Z');

/**
 * An open `ballot_final_after_transfer` flag pointing at one ballot, with the
 * audit event it must keep as its source. `impacted_ballot_id` is ON DELETE
 * SET NULL, so this is the row that silently lost its reference every time a
 * board member corrected one lot on the register.
 */
async function seedBallotFlag(flagId: string, ballotId: string) {
  const db = getDb(env);
  const eventId = crypto.randomUUID();
  await db.insert(auditEvents).values({
    id: eventId,
    family: 'review',
    eventKind: 'review_flag_opened',
    correlationId: crypto.randomUUID(),
    correlationSequence: 0,
    causingEventId: null,
    actorKind: 'bootstrap',
    actorAccountId: null,
    automaticCause: null,
    operationKey: crypto.randomUUID(),
    recordedAt: originallyRecorded,
  });
  await db.insert(reviewFlags).values({
    id: flagId,
    category: 'ballot_final_after_transfer',
    sourceEventId: eventId,
    status: 'open',
    openedAt: originallyRecorded,
    impactedBallotId: ballotId,
  });
}

async function flag(flagId: string) {
  const [row] = await getDb(env)
    .select()
    .from(reviewFlags)
    .where(eq(reviewFlags.id, flagId));
  return row;
}

async function registerFor(electionId: string) {
  return getDb(env)
    .select()
    .from(ballots)
    .where(eq(ballots.electionId, electionId));
}

describe('setBallots amends a recorded register without disturbing it', () => {
  it('keeps an unchanged lot’s id and recorded_at when another lot is added', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });

    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1' }, { propertyId: 'p2' }],
      }),
    );

    expect(res.status).toBe(204);
    const rows = await registerFor('e1');
    expect(rows.length).toBe(2);
    const p1 = rows.find((r) => r.propertyId === 'p1');
    expect(p1?.id).toBe('b1');
    expect(p1?.recordedAt.getTime()).toBe(originallyRecorded.getTime());
    expect(rows.find((r) => r.propertyId === 'p2')).toBeDefined();
  });

  it('leaves an open review flag still pointing at an unchanged ballot', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });
    await seedBallotFlag('f1', 'b1');

    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1' }, { propertyId: 'p2' }],
      }),
    );

    expect(res.status).toBe(204);
    expect((await flag('f1'))?.impactedBallotId).toBe('b1');
  });

  it('corrects a lot’s weight in place, on the same row', async () => {
    await seedProperty('p1');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', {
      weight: 1,
      recordedAt: originallyRecorded,
    });

    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', weight: 4 }],
      }),
    );

    expect(res.status).toBe(204);
    const [row] = await registerFor('e1');
    expect(row.weight).toBe(4);
    expect(row.id).toBe('b1');
    expect(row.recordedAt.getTime()).toBe(originallyRecorded.getTime());
  });

  it('corrects a lot’s provenance in place, on the same row', async () => {
    await seedProperty('p1');
    await seedPerson('per1');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });

    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1', castByPersonId: 'per1' }],
      }),
    );

    expect(res.status).toBe(204);
    const [row] = await registerFor('e1');
    expect(row.castByPersonId).toBe('per1');
    expect(row.id).toBe('b1');
    expect(row.recordedAt.getTime()).toBe(originallyRecorded.getTime());
  });

  it('stamps the amendment instant on a newly added lot', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });

    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p1' }, { propertyId: 'p2' }],
      }),
    );

    expect(res.status).toBe(204);
    const rows = await registerFor('e1');
    const added = rows.find((r) => r.propertyId === 'p2');
    // "Entered on", which is the honest reading for a lot the board added.
    expect(added!.recordedAt.getTime()).toBeGreaterThan(
      originallyRecorded.getTime(),
    );
  });

  it('still clears the whole register for empty entries', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1');
    await seedBallot('b2', 'e1', 'p2');

    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [],
      }),
    );

    expect(res.status).toBe(204);
    expect((await registerFor('e1')).length).toBe(0);
  });

  it('leaves every row untouched when a void wins the race', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });

    const barrier = pauseNextBatch();
    try {
      const amendment = POST(
        req(url, 'POST', {
          action: 'setBallots',
          electionId: 'e1',
          entries: [{ propertyId: 'p1' }, { propertyId: 'p2' }],
        }),
      );
      await barrier.reached;
      expect(
        (await POST(req(url, 'POST', { action: 'void', id: 'e1' }))).status,
      ).toBe(204);
      barrier.release();
      expect((await amendment).status).toBe(409);
    } finally {
      barrier.release();
      barrier.restore();
    }

    // Every child statement was gated on the reservation, so the narrowed
    // DELETE must not have run either.
    const rows = await registerFor('e1');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('b1');
    expect(rows[0].recordedAt.getTime()).toBe(originallyRecorded.getTime());
  });

  it('converges when two amendments add the same lot', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });

    const entries = [{ propertyId: 'p1' }, { propertyId: 'p2' }];
    const barrier = pauseNextBatch();
    let first: Response;
    try {
      const amendment = POST(
        req(url, 'POST', { action: 'setBallots', electionId: 'e1', entries }),
      );
      await barrier.reached;
      // The second board member submits the same correction and completes.
      expect(
        (
          await POST(
            req(url, 'POST', {
              action: 'setBallots',
              electionId: 'e1',
              entries,
            }),
          )
        ).status,
      ).toBe(204);
      barrier.release();
      first = await amendment;
    } finally {
      barrier.release();
      barrier.restore();
    }

    // Last writer wins, as before. The narrowed DELETE no longer clears the
    // row the other call just wrote, so without the upsert this would be a
    // raw D1 unique-index error out of the batch.
    expect(first.status).not.toBe(500);
    const rows = await registerFor('e1');
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.propertyId === 'p2').length).toBe(1);
  });

  it('clears the flag reference for a lot dropped from the register', async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedElection('e1');
    await seedBallot('b1', 'e1', 'p1', { recordedAt: originallyRecorded });
    await seedBallot('b2', 'e1', 'p2', { recordedAt: originallyRecorded });
    await seedBallotFlag('f1', 'b1');
    await seedBallotFlag('f2', 'b2');

    // p1 returned no ballot after all; p2 stays.
    const res = await POST(
      req(url, 'POST', {
        action: 'setBallots',
        electionId: 'e1',
        entries: [{ propertyId: 'p2' }],
      }),
    );

    expect(res.status).toBe(204);
    // The documented SET NULL remedy: the flag survives with its source event
    // and ledger context, impact unset.
    const dropped = await flag('f1');
    expect(dropped?.impactedBallotId).toBeNull();
    expect(dropped?.status).toBe('open');
    expect((await flag('f2'))?.impactedBallotId).toBe('b2');
  });
});
