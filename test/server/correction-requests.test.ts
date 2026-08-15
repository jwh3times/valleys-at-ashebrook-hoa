import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  contactMethods,
  correctionRequests,
} from '../../src/server/db/roster-schema';
import { legacyAuthContext } from '../../src/server/authz/context';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  GET as memberList,
  POST as memberSubmit,
  DELETE as memberWithdraw,
} from '../../src/pages/api/member/correction-requests';
import {
  GET as adminList,
  POST as adminDecide,
} from '../../src/pages/api/admin/correction-requests';

/**
 * #218's correction-request flow, end to end: members submit REQUESTS, never
 * facts (#205); the request's free text never reaches the audit ledger;
 * acceptance is an ordinary board Roster Change citing the request id as
 * opaque evidence; a decline or withdrawal leaves no ledger trace at all.
 */

// The admin route resolves the board caller through getAuthContext when
// invoked without middleware, so pin it to a board context; the member routes
// receive their caller via locals below and never hit this mock.
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
  'correction_requests',
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'roster_change_subjects',
  'roster_changes',
  'audit_events',
  'contact_methods',
  'people',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw('DELETE FROM properties'));
  await db.run(sql.raw('DELETE FROM users'));
  await db.delete(settings).where(eq(settings.key, 'site'));
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    updatedAt: new Date(),
  });
  await seedAccount('board-1');
});

async function seedAccount(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedPerson(id: string, fullName: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env).insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName,
    nameNormalized: fullName.toLowerCase(),
    updatedAt: now,
  });
}

async function seedContactMethod(
  id: string,
  partyId: string,
  value = `${id}@example.test`,
) {
  const now = new Date();
  await getDb(env).insert(contactMethods).values({
    id,
    partyId,
    channel: 'email',
    value,
    valueNormalized: value.toLowerCase(),
    isPreferred: true,
    startDay: null,
    createdAt: now,
    updatedAt: now,
  });
}

function memberCtx(userId: string, personId: string): AuthContext {
  return {
    userId,
    personId,
    capabilities: new Set(['member']),
    lotIds: ['lot-1'],
    contentTier: 'homeowner',
    hasCurrentBoardTerm: false,
    role: 'homeowner',
    propertyIds: ['lot-1'],
  };
}

function memberReq(
  ctx: AuthContext | null,
  method: string,
  body?: unknown,
): never {
  return {
    request: new Request('http://localhost/api/member/correction-requests', {
      method,
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never;
}

function adminReq(method: string, body?: unknown): never {
  return {
    request: new Request('http://localhost/api/admin/correction-requests', {
      method,
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

async function ledgerCounts() {
  const db = getDb(env);
  const [events] = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM audit_events`,
  );
  return events.n;
}

async function submitNameRequest(userId: string, personId: string) {
  const res = await memberSubmit(
    memberReq(memberCtx(userId, personId), 'POST', {
      kind: 'name',
      proposedValue: 'Jamie Q. Corrected',
      note: 'married name PRIVATE-NOTE-TEXT',
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('member correction requests', () => {
  it('submits a name request without touching the ledger or the roster', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    const before = await ledgerCounts();

    const id = await submitNameRequest('mem-1', 'per-1');

    expect(await ledgerCounts()).toBe(before);
    const db = getDb(env);
    const [person] = await db
      .select({ fullName: people.fullName })
      .from(people)
      .where(eq(people.partyId, 'per-1'));
    expect(person.fullName).toBe('Jamie Resident');
    const [row] = await db
      .select()
      .from(correctionRequests)
      .where(eq(correctionRequests.id, id));
    expect(row.status).toBe('open');
    expect(row.note).toContain('PRIVATE-NOTE-TEXT');
  });

  it('refuses a second open request for the same target', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    await submitNameRequest('mem-1', 'per-1');
    const res = await memberSubmit(
      memberReq(memberCtx('mem-1', 'per-1'), 'POST', {
        kind: 'name',
        proposedValue: 'Another Name',
      }),
    );
    expect(res.status).toBe(409);
  });

  it("masks another person's contact method as 404, identically to a missing one", async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    await seedPerson('per-2', 'Other Resident');
    await seedContactMethod('cm-other', 'per-2');

    const foreign = await memberSubmit(
      memberReq(memberCtx('mem-1', 'per-1'), 'POST', {
        kind: 'contact_method',
        contactMethodId: 'cm-other',
        proposedValue: 'new@example.test',
      }),
    );
    const missing = await memberSubmit(
      memberReq(memberCtx('mem-1', 'per-1'), 'POST', {
        kind: 'contact_method',
        contactMethodId: 'cm-never-existed',
        proposedValue: 'new@example.test',
      }),
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
  });

  it('withdraws own open request and masks everything else as 404', async () => {
    await seedAccount('mem-1');
    await seedAccount('mem-2');
    await seedPerson('per-1', 'Jamie Resident');
    await seedPerson('per-2', 'Other Resident');
    const id = await submitNameRequest('mem-1', 'per-1');
    const before = await ledgerCounts();

    const foreign = await memberWithdraw(
      memberReq(memberCtx('mem-2', 'per-2'), 'DELETE', { id }),
    );
    expect(foreign.status).toBe(404);

    const own = await memberWithdraw(
      memberReq(memberCtx('mem-1', 'per-1'), 'DELETE', { id }),
    );
    expect(own.status).toBe(204);
    expect(await ledgerCounts()).toBe(before);

    const again = await memberWithdraw(
      memberReq(memberCtx('mem-1', 'per-1'), 'DELETE', { id }),
    );
    expect(again.status).toBe(404);
  });

  it('lists own requests and 403s an unlinked caller with the verification pointer', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    await submitNameRequest('mem-1', 'per-1');

    const list = await memberList(
      memberReq(memberCtx('mem-1', 'per-1'), 'GET'),
    );
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const unlinked = await memberList(
      memberReq(legacyAuthContext('mem-1', 'homeowner', []), 'GET'),
    );
    expect(unlinked.status).toBe(403);
  });
});

describe('board review of correction requests', () => {
  it('accepting a name request applies the fact as a Roster Change citing the request', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    const id = await submitNameRequest('mem-1', 'per-1');

    const res = await adminDecide(
      adminReq('POST', { action: 'accept', requestId: id }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [person] = await db
      .select({ fullName: people.fullName })
      .from(people)
      .where(eq(people.partyId, 'per-1'));
    expect(person.fullName).toBe('Jamie Q. Corrected');

    const [row] = await db
      .select()
      .from(correctionRequests)
      .where(eq(correctionRequests.id, id));
    expect(row.status).toBe('accepted');
    expect(row.decidedByAccountId).toBe('board-1');

    // One correlation: a roster_change root citing the request as evidence.
    const [change] = await db.all<{
      evidence_kind: string;
      evidence_request_id: string;
      reason_code: string;
    }>(
      sql`SELECT rc.evidence_kind, rc.evidence_request_id, rc.reason_code
          FROM roster_changes rc JOIN audit_events e ON e.id = rc.event_id
          WHERE e.event_kind = 'person_name_corrected'`,
    );
    expect(change).toMatchObject({
      evidence_kind: 'request',
      evidence_request_id: id,
      reason_code: 'correction_request_accepted',
    });

    // The request's free text never enters the ledger: not the note, and not
    // the proposed value in any audit column (the accepted value lives only on
    // the domain row itself).
    for (const [table, columns] of [
      ['audit_scalar_changes', ['old_text', 'new_text']],
      ['roster_changes', ['external_reference']],
      ['audit_events', ['event_kind', 'automatic_cause', 'operation_key']],
    ] as const) {
      for (const column of columns) {
        const hits = await db.all<{ n: number }>(
          sql.raw(
            `SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" LIKE '%PRIVATE-NOTE-TEXT%' OR "${column}" LIKE '%Jamie Q. Corrected%'`,
          ),
        );
        expect(
          hits[0].n,
          `${table}.${column} must not carry request text`,
        ).toBe(0);
      }
    }
    // ...but the CATEGORY of the sensitive change is recorded.
    const sensitive = await db.all<{ field_category: string }>(
      sql`SELECT field_category FROM audit_sensitive_field_changes`,
    );
    expect(sensitive.map((s) => s.field_category)).toContain('person_name');
  });

  it('accepting a contact correction ends the old method and creates the new one atomically', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    await seedContactMethod('cm-1', 'per-1', 'old@example.test');
    const submit = await memberSubmit(
      memberReq(memberCtx('mem-1', 'per-1'), 'POST', {
        kind: 'contact_method',
        contactMethodId: 'cm-1',
        proposedValue: 'new@example.test',
      }),
    );
    expect(submit.status).toBe(201);
    const id = ((await submit.json()) as { id: string }).id;

    const res = await adminDecide(
      adminReq('POST', { action: 'accept', requestId: id }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const rows = await db
      .select()
      .from(contactMethods)
      .where(eq(contactMethods.partyId, 'per-1'));
    const old = rows.find((r) => r.id === 'cm-1');
    const created = rows.find((r) => r.id !== 'cm-1');
    expect(old?.endDay).not.toBeNull();
    expect(old?.isPreferred).toBe(false);
    expect(created).toMatchObject({
      value: 'new@example.test',
      isPreferred: true,
      channel: 'email',
    });

    // One event, three subjects: old ended, new created, party primary.
    const subjects = await db.all<{ role: string }>(
      sql`SELECT s.role FROM roster_change_subjects s
          JOIN audit_events e ON e.id = s.event_id
          WHERE e.event_kind = 'contact_method_corrected'`,
    );
    expect(subjects.map((s) => s.role).sort()).toEqual([
      'created',
      'ended',
      'primary',
    ]);
  });

  it('accepting a new-method proposal records one created method', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    const submit = await memberSubmit(
      memberReq(memberCtx('mem-1', 'per-1'), 'POST', {
        kind: 'contact_method',
        channel: 'sms',
        proposedValue: '704-555-0100',
      }),
    );
    expect(submit.status).toBe(201);
    const id = ((await submit.json()) as { id: string }).id;

    const res = await adminDecide(
      adminReq('POST', { action: 'accept', requestId: id }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const rows = await db
      .select()
      .from(contactMethods)
      .where(eq(contactMethods.partyId, 'per-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('sms');
    expect(rows[0].isPreferred).toBe(false);
  });

  it('declining writes no ledger row and a decided request cannot be re-decided', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    const id = await submitNameRequest('mem-1', 'per-1');
    const before = await ledgerCounts();

    const decline = await adminDecide(
      adminReq('POST', { action: 'decline', requestId: id }),
    );
    expect(decline.status).toBe(204);
    expect(await ledgerCounts()).toBe(before);

    const accept = await adminDecide(
      adminReq('POST', { action: 'accept', requestId: id }),
    );
    expect(accept.status).toBe(409);

    const db = getDb(env);
    const [person] = await db
      .select({ fullName: people.fullName })
      .from(people)
      .where(eq(people.partyId, 'per-1'));
    expect(person.fullName).toBe('Jamie Resident');
  });

  it('refuses to accept a name correction for a redacted person', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    const id = await submitNameRequest('mem-1', 'per-1');
    await getDb(env).run(
      sql`UPDATE people SET full_name = NULL, name_normalized = NULL, name_redacted_at = ${Date.now()} WHERE party_id = ${'per-1'}`,
    );
    const res = await adminDecide(
      adminReq('POST', { action: 'accept', requestId: id }),
    );
    expect(res.status).toBe(409);
  });

  it('lists requests with the person display name for board review', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    await submitNameRequest('mem-1', 'per-1');
    const res = await adminList(adminReq('GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { personDisplayName: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].personDisplayName).toBe('Jamie Resident');
  });

  it('integrity views stay empty across the whole flow', async () => {
    await seedAccount('mem-1');
    await seedPerson('per-1', 'Jamie Resident');
    const id = await submitNameRequest('mem-1', 'per-1');
    await adminDecide(adminReq('POST', { action: 'accept', requestId: id }));
    const db = getDb(env);
    const violations = await db.all(
      sql`SELECT * FROM audit_integrity_violations_v`,
    );
    expect(violations).toEqual([]);
  });
});
