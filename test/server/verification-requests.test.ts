import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  personVerifications,
  personLinks,
  verificationReviewRequests,
} from '../../src/server/db/roster-schema';
import { pauseNextBatch } from './fixtures';
import { getAuthContext } from '../../src/server/authz/context';
import { GET, POST } from '../../src/pages/api/admin/verification-requests';

/**
 * #219's board review queue (PLAN-3c D6/D7): applicant free text
 * (`claimed_address`/`claimed_name`) must never reach the ledger; accept is
 * manual verification citing the request as opaque evidence; decline still
 * writes a durable, ledgered denial (#201 — unlike a correction-request
 * decline, which leaves no trace at all).
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: vi.fn(async () =>
    (
      await importActual<typeof import('../../src/server/authz/context')>()
    ).legacyAuthContext('board-1', 'board', []),
  ),
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
  'identity_events',
  'access_events',
  'audit_events',
  'verification_review_requests',
  'access_grants',
  'person_links',
  'person_verifications',
  'board_service_terms',
  'people',
  'parties',
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
  await db.run(sql.raw('DELETE FROM users'));
  for (const id of ['board-1', 'acct-1']) {
    const now = new Date();
    await db.insert(users).values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  }
});

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

const CLAIMED_ADDRESS = '123 Secret Lane';
const CLAIMED_NAME = 'Jane Q. Applicant';

async function seedRequest(
  id: string,
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date();
  await getDb(env)
    .insert(verificationReviewRequests)
    .values({
      id,
      accountId,
      claimedAddress: CLAIMED_ADDRESS,
      claimedName: CLAIMED_NAME,
      channel: 'email',
      internalReason: 'applicant_requested',
      status: 'open',
      createdAt: now,
      ...overrides,
    });
}

function req(body: unknown, method = 'POST'): never {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(
      'http://localhost/api/admin/verification-requests',
      init,
    ),
  } as never;
}

describe('GET', () => {
  it('lists only open requests', async () => {
    await seedRequest('req-open', 'acct-1');
    await seedRequest('req-declined', 'acct-1', {
      status: 'declined',
      resolvedAt: new Date(),
      resolvedByAccountId: 'board-1',
    });
    const res = await GET(req(undefined, 'GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; accountEmail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'req-open',
      accountEmail: 'acct-1@example.test',
    });
  });

  it('is board-gated', async () => {
    // Smoke check: an anonymous caller (no session) is refused before the
    // route touches the body. The full permission matrix is exercised by
    // permission-matrix.test.ts; this just confirms the route calls
    // requireBoard ahead of everything else.
    vi.mocked(getAuthContext).mockResolvedValueOnce(null);
    const res = await GET(req(undefined, 'GET'));
    expect(res.status).toBe(401);
  });
});

describe('accept', () => {
  it('creates verification, link, and identity event citing the request', async () => {
    await seedPerson('per-1');
    await seedRequest('req-1', 'acct-1');

    const res = await POST(
      req({ action: 'accept', id: 'req-1', personId: 'per-1' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      linkId: string;
      verificationId: string;
    };

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, body.linkId));
    expect(link.accountId).toBe('acct-1');
    expect(link.personId).toBe('per-1');

    const [request] = await db
      .select()
      .from(verificationReviewRequests)
      .where(eq(verificationReviewRequests.id, 'req-1'));
    expect(request.status).toBe('accepted');
    expect(request.resolvedByAccountId).toBe('board-1');

    const events = await db.all<{
      event_kind: string;
      evidence_kind: string;
      evidence_request_id: string;
      reason_code: string;
    }>(
      sql`SELECT e.event_kind, ie.evidence_kind, ie.evidence_request_id, ie.reason_code
          FROM identity_events ie JOIN audit_events e ON e.id = ie.event_id
          WHERE e.event_kind = 'person_verified'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      evidence_kind: 'request',
      evidence_request_id: 'req-1',
      reason_code: 'manual_board_decision',
    });

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('defaults reason to manual_board_decision', async () => {
    await seedPerson('per-1');
    await seedRequest('req-1', 'acct-1');
    const res = await POST(
      req({ action: 'accept', id: 'req-1', personId: 'per-1' }),
    );
    expect(res.status).toBe(201);
    const db = getDb(env);
    const [verification] = await db.select().from(personVerifications);
    expect(verification.reason).toBe('manual_board_decision');
  });

  it('404s an unknown request', async () => {
    await seedPerson('per-1');
    const res = await POST(
      req({ action: 'accept', id: 'nope', personId: 'per-1' }),
    );
    expect(res.status).toBe(404);
  });

  it('409s an already-resolved request', async () => {
    await seedPerson('per-1');
    await seedRequest('req-1', 'acct-1', {
      status: 'declined',
      resolvedAt: new Date(),
      resolvedByAccountId: 'board-1',
    });
    const res = await POST(
      req({ action: 'accept', id: 'req-1', personId: 'per-1' }),
    );
    expect(res.status).toBe(409);
  });

  it('holds atomicity under a race: a request resolved mid-flight leaves zero identity rows', async () => {
    await seedPerson('per-1');
    await seedRequest('req-1', 'acct-1');
    const pause = pauseNextBatch();
    try {
      const accept = POST(
        req({ action: 'accept', id: 'req-1', personId: 'per-1' }),
      );
      await pause.reached;
      // Declines the SAME request while accept's batch is parked — its own
      // batch call is not the first, so it runs through unpaused.
      const decline = await POST(req({ action: 'decline', id: 'req-1' }));
      expect(decline.status).toBe(204);
      pause.release();
      const acceptRes = await accept;
      expect(acceptRes.status).toBe(409);
    } finally {
      pause.restore();
    }
    const db = getDb(env);
    expect(await db.select().from(personVerifications)).toHaveLength(0);
    expect(await db.select().from(personLinks)).toHaveLength(0);
    const [request] = await db
      .select()
      .from(verificationReviewRequests)
      .where(eq(verificationReviewRequests.id, 'req-1'));
    expect(request.status).toBe('declined');
  });
});

describe('decline', () => {
  it('marks the request declined and writes a durable identity event with no person refs and no free text', async () => {
    await seedRequest('req-1', 'acct-1');
    const res = await POST(req({ action: 'decline', id: 'req-1' }));
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [request] = await db
      .select()
      .from(verificationReviewRequests)
      .where(eq(verificationReviewRequests.id, 'req-1'));
    expect(request.status).toBe('declined');
    expect(request.resolvedByAccountId).toBe('board-1');

    const events = await db.all<{
      event_kind: string;
      reason_code: string;
      person_id: string | null;
      person_verification_id: string | null;
      person_link_id: string | null;
      target_account_id: string;
      evidence_kind: string;
      evidence_request_id: string;
    }>(
      sql`SELECT e.event_kind, ie.reason_code, ie.person_id, ie.person_verification_id, ie.person_link_id, ie.target_account_id, ie.evidence_kind, ie.evidence_request_id
          FROM identity_events ie JOIN audit_events e ON e.id = ie.event_id
          WHERE e.event_kind = 'verification_declined'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason_code: 'verification_review_declined',
      person_id: null,
      person_verification_id: null,
      person_link_id: null,
      target_account_id: 'acct-1',
      evidence_kind: 'request',
      evidence_request_id: 'req-1',
    });

    // The applicant's free text never enters the ledger — search every
    // identity_events text-bearing column for it.
    const leaked = await db.all(
      sql`SELECT * FROM identity_events
          WHERE reason_code = ${CLAIMED_ADDRESS} OR reason_code = ${CLAIMED_NAME}
             OR evidence_request_id = ${CLAIMED_ADDRESS} OR evidence_request_id = ${CLAIMED_NAME}
             OR external_reference = ${CLAIMED_ADDRESS} OR external_reference = ${CLAIMED_NAME}`,
    );
    expect(leaked).toEqual([]);

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('404s an unknown request', async () => {
    const res = await POST(req({ action: 'decline', id: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('409s an already-resolved request', async () => {
    await seedRequest('req-1', 'acct-1', {
      status: 'accepted',
      resolvedAt: new Date(),
      resolvedByAccountId: 'board-1',
    });
    const res = await POST(req({ action: 'decline', id: 'req-1' }));
    expect(res.status).toBe(409);
  });
});
