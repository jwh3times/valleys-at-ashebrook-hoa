import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { GET, POST } from '../../src/pages/api/member/tenancies';
import { associationDateIso } from '../../src/lib/format';
import { deriveAccess } from '../../src/server/authz/derive';
import type { AuthContext } from '../../src/server/authz/guards';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  pauseNextBatch,
  seedLotAuthority,
  seedProperty,
  seedPerson,
} from './fixtures';
import { seedAccountLink } from './roster-fixtures';
import { resetTenancyWorld, seedTenancy, tenancy } from './tenancy-fixtures';

// #294 slice 3 (ADR 0028, spec decision 3): an owner's half of Tenant Access.
// Any current holder of Lot Authority over a Lot may request a Tenancy for it,
// renew or end one, and withdraw an open request, whoever made it. Everything
// outside the caller's Lots answers the masked 404.
//
// Callers are derived from the seeded roster, never supplied, so these tests
// exercise the real Lot Authority the route scopes by.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const URL = 'http://localhost/api/member/tenancies';
const today = associationDateIso();

/** `today` moved by whole months, the way SQLite's `date(d, '+N months')`
 * moves it. */
function monthsOut(months: number, days = 0): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function setGates(officialMode: boolean, tenantAccessEnabled: boolean) {
  await getDb(env).run(sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('site', ${JSON.stringify({ officialMode, tenantAccessEnabled })}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
}

async function account(accountId: string, personId: string) {
  await getDb(env)
    .insert(users)
    .values({
      id: accountId,
      name: accountId,
      email: `${accountId}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await seedAccountLink(accountId, personId);
}

async function call(
  accountId: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Response> {
  return send(await deriveAccess(env, accountId, today), method, body);
}

/** Sends as an already-derived caller, so a test can pause the route's own
 * batch without catching the derivation's. */
async function send(
  authContext: AuthContext,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers = {
    'content-type': 'application/json',
    origin: 'http://localhost',
  };
  const context = {
    request:
      method === 'GET'
        ? new Request(URL, { headers })
        : new Request(URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body ?? {}),
          }),
    locals: { authContext },
  } as never;
  return method === 'GET' ? GET(context) : POST(context);
}

const newRequest = (overrides: Record<string, unknown> = {}) => ({
  action: 'request',
  lotId: 'lot',
  tenantName: 'Tess Tenant',
  channel: 'email',
  contact: 'Tess@Example.test',
  scheduledEndDay: monthsOut(12),
  ...overrides,
});

interface RequestRow {
  id: string;
  lot_id: string;
  requested_by_account_id: string;
  requested_by_person_id: string;
  basis_ownership_id: string;
  kind: string;
  renews_tenancy_id: string | null;
  tenant_name: string | null;
  channel: string | null;
  contact_value: string | null;
  contact_normalized: string | null;
  scheduled_end_day: string;
  status: string;
  decided_by_account_id: string | null;
}

async function requests(): Promise<RequestRow[]> {
  const { results } = await env.DATABASE.prepare(
    'SELECT * FROM tenancy_requests ORDER BY created_at, id',
  ).all<RequestRow>();
  return results;
}

/** An Organization owning `lotId` from 2025-01-01, as Ownership `org-<lot>`. */
async function organizationOwning(lotId: string) {
  await getDb(env).run(sql`
    INSERT INTO parties (id, kind, created_at, updated_at)
    VALUES ('org', 'organization', 1, 1) ON CONFLICT DO NOTHING`);
  await getDb(env).run(sql`
    INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
    VALUES ('org', 'organization', 'Example Holdings LLC', 'example holdings llc', 1)
    ON CONFLICT DO NOTHING`);
  await getDb(env).run(sql`
    INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
    VALUES (${`org-${lotId}`}, 'org', ${lotId}, '2025-01-01', 1, 1)`);
}

async function representative(
  personId: string,
  scope: 'organization' | { lots: string[] },
) {
  await seedPerson(personId);
  await getDb(env).run(sql`
    INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
    VALUES (${`rep-${personId}`}, ${personId}, 'org', ${scope === 'organization' ? 'organization' : 'lots'}, '2025-01-01', 1, 1)`);
  if (scope !== 'organization')
    for (const lotId of scope.lots)
      await getDb(env).run(sql`
        INSERT INTO representation_lots (representation_id, lot_id, created_at)
        VALUES (${`rep-${personId}`}, ${lotId}, 1)`);
}

beforeEach(async () => {
  await resetTenancyWorld();
  await env.DATABASE.prepare('DELETE FROM settings').run();
  await setGates(true, true);
  await account('acct-owner', 'owner');
  // A neighbour who holds a different Lot, and nothing of `lot`.
  await seedProperty('other-lot');
  await seedLotAuthority('neighbour', 'other-lot', { startDay: '2025-01-01' });
  await account('acct-neighbour', 'neighbour');
});

describe('the gates', () => {
  it('answers 404 to request and renew when either gate is off', async () => {
    await seedTenancy('ten', {
      startDay: '2025-06-01',
      scheduledEndDay: monthsOut(2),
    });
    for (const [official, tenant] of [
      [false, true],
      [true, false],
    ] as const) {
      await setGates(official, tenant);
      expect((await call('acct-owner', 'POST', newRequest())).status).toBe(404);
      expect(
        (
          await call('acct-owner', 'POST', {
            action: 'renew',
            tenancyId: 'ten',
            scheduledEndDay: monthsOut(14),
          })
        ).status,
      ).toBe(404);
    }
    expect(await requests()).toEqual([]);
  });

  it('still withdraws, ends and lists with tenant access off, so nothing waits on a setting', async () => {
    await seedTenancy('ten', {
      startDay: '2025-06-01',
      scheduledEndDay: monthsOut(2),
    });
    const opened = await call('acct-owner', 'POST', newRequest());
    const { id } = (await opened.json()) as { id: string };
    await setGates(true, false);
    const listed = await call('acct-owner', 'GET');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      expect.objectContaining({
        lotId: 'lot',
        tenancies: [expect.objectContaining({ id: 'ten' })],
        openRequests: [expect.objectContaining({ id })],
      }),
    ]);
    expect(
      (await call('acct-owner', 'POST', { action: 'withdraw', requestId: id }))
        .status,
    ).toBe(204);
    expect(
      (await call('acct-owner', 'POST', { action: 'end', tenancyId: 'ten' }))
        .status,
    ).toBe(204);
    expect(await requests()).toEqual([
      expect.objectContaining({ id, status: 'withdrawn', tenant_name: null }),
    ]);
  });

  it('answers 403 to a caller who holds no Lot', async () => {
    await account('acct-tenant', 'tenant');
    expect((await call('acct-tenant', 'GET')).status).toBe(403);
    expect((await call('acct-tenant', 'POST', newRequest())).status).toBe(403);
  });
});

describe('request', () => {
  it('opens a new request on the direct owner’s Ownership, with the contact normalized', async () => {
    const res = await call('acct-owner', 'POST', newRequest());
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await requests()).toEqual([
      expect.objectContaining({
        id,
        lot_id: 'lot',
        requested_by_account_id: 'acct-owner',
        requested_by_person_id: 'owner',
        basis_ownership_id: 'owner-lot-own',
        kind: 'new',
        renews_tenancy_id: null,
        tenant_name: 'Tess Tenant',
        channel: 'email',
        contact_value: 'Tess@Example.test',
        contact_normalized: 'tess@example.test',
        scheduled_end_day: monthsOut(12),
        status: 'open',
      }),
    ]);
  });

  it('normalizes a phone number the way the roster does', async () => {
    await call(
      'acct-owner',
      'POST',
      newRequest({ channel: 'sms', contact: '(555) 555-0142' }),
    );
    expect(await requests()).toMatchObject([
      { channel: 'sms', contact_normalized: '+15555550142' },
    ]);
  });

  it('answers the masked 404 for a Lot the caller does not hold, or no Lot at all', async () => {
    for (const lotId of ['other-lot', 'no-such-lot']) {
      const res = await call('acct-owner', 'POST', newRequest({ lotId }));
      expect(res.status).toBe(404);
    }
    expect(await requests()).toEqual([]);
  });

  it('accepts an organization-wide or a Lot-scoped Representative, on the Organization’s Ownership', async () => {
    await seedProperty('org-lot');
    await organizationOwning('org-lot');
    await representative('rep-wide', 'organization');
    await representative('rep-scoped', { lots: ['org-lot'] });
    await account('acct-wide', 'rep-wide');
    await account('acct-scoped', 'rep-scoped');
    for (const [acct, contact] of [
      ['acct-wide', 'one@example.test'],
      ['acct-scoped', 'two@example.test'],
    ]) {
      const res = await call(
        acct,
        'POST',
        newRequest({ lotId: 'org-lot', contact }),
      );
      expect(res.status).toBe(201);
    }
    expect(
      (await requests()).map((r) => [
        r.requested_by_person_id,
        r.basis_ownership_id,
      ]),
    ).toEqual([
      ['rep-wide', 'org-org-lot'],
      ['rep-scoped', 'org-org-lot'],
    ]);
  });

  it('refuses a Lot-scoped Representative a Lot outside their scope', async () => {
    await seedProperty('org-lot');
    await seedProperty('org-lot-2');
    await organizationOwning('org-lot');
    await organizationOwning('org-lot-2');
    await representative('rep-scoped', { lots: ['org-lot'] });
    await account('acct-scoped', 'rep-scoped');
    const res = await call(
      'acct-scoped',
      'POST',
      newRequest({ lotId: 'org-lot-2' }),
    );
    expect(res.status).toBe(404);
  });

  it('prefers the caller’s own Ownership when they also represent the owning Organization', async () => {
    await organizationOwning('lot');
    await getDb(env).run(sql`
      INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
      VALUES ('rep-owner', 'owner', 'org', 'organization', '2025-01-01', 1, 1)`);
    await call('acct-owner', 'POST', newRequest());
    expect(await requests()).toMatchObject([
      { basis_ownership_id: 'owner-lot-own' },
    ]);
  });

  it('answers 409 to a second open request for the same contact on the same Lot', async () => {
    await seedLotAuthority('co-owner', 'lot', { startDay: '2025-01-01' });
    await account('acct-co', 'co-owner');
    expect((await call('acct-owner', 'POST', newRequest())).status).toBe(201);
    const dup = await call(
      'acct-co',
      'POST',
      newRequest({ contact: '  tess@EXAMPLE.test ' }),
    );
    expect(dup.status).toBe(409);
    expect(await requests()).toHaveLength(1);
  });

  it('holds the end day after today and at most 13 months out', async () => {
    for (const scheduledEndDay of [today, monthsOut(13, 1), 'next week']) {
      const res = await call(
        'acct-owner',
        'POST',
        newRequest({ scheduledEndDay }),
      );
      expect(res.status).toBe(400);
    }
    expect(
      (
        await call(
          'acct-owner',
          'POST',
          newRequest({ scheduledEndDay: monthsOut(13) }),
        )
      ).status,
    ).toBe(201);
  });

  it('requires a name and a well-formed contact on a known channel', async () => {
    for (const overrides of [
      { tenantName: '  ' },
      { channel: 'fax' },
      { contact: 'not-an-email' },
      { channel: 'sms', contact: '555-01' },
    ]) {
      const res = await call('acct-owner', 'POST', newRequest(overrides));
      expect(res.status).toBe(400);
    }
    expect(await requests()).toEqual([]);
  });

  it('re-checks Lot Authority inside the insert, so an Ownership ended mid-request writes nothing', async () => {
    const owner = await deriveAccess(env, 'acct-owner', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(owner, 'POST', newRequest());
      await paused.reached;
      await getDb(env).run(
        sql`UPDATE ownerships SET end_day = ${today} WHERE id = 'owner-lot-own'`,
      );
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await requests()).toEqual([]);
  });

  it('re-checks its basis Ownership inside the insert, so one voided mid-request writes nothing', async () => {
    // The owner also represents the owning Organization, so voiding their own
    // Ownership leaves them Lot Authority, but not the basis the preflight chose.
    await organizationOwning('lot');
    await getDb(env).run(sql`
      INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
      VALUES ('rep-owner', 'owner', 'org', 'organization', '2025-01-01', 1, 1)`);
    const owner = await deriveAccess(env, 'acct-owner', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(owner, 'POST', newRequest());
      await paused.reached;
      await getDb(env).run(
        sql`UPDATE ownerships SET voided_at = 1 WHERE id = 'owner-lot-own'`,
      );
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await requests()).toEqual([]);
  });

  it('answers 409 for a retired Lot, which is no basis for a Tenancy', async () => {
    // A second, live Lot keeps the owner a member once `lot` is retired.
    await seedProperty('lot-2');
    await seedLotAuthority('owner', 'lot-2', { startDay: '2025-01-01' });
    await getDb(env).run(sql`UPDATE lots SET retired_at = 1 WHERE id = 'lot'`);
    const owner = await deriveAccess(env, 'acct-owner', today);
    expect((await send(owner, 'POST', newRequest())).status).toBe(409);
    expect(await requests()).toEqual([]);
  });

  it('re-checks both gates inside the insert, so a gate turned off mid-request writes nothing', async () => {
    const owner = await deriveAccess(env, 'acct-owner', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(owner, 'POST', newRequest());
      await paused.reached;
      await setGates(true, false);
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await requests()).toEqual([]);
  });
});

describe('renew', () => {
  const renew = (overrides: Record<string, unknown> = {}) => ({
    action: 'renew',
    tenancyId: 'ten',
    scheduledEndDay: monthsOut(14),
    ...overrides,
  });

  beforeEach(async () => {
    // Current, and scheduled to end in two months.
    await seedTenancy('ten', {
      startDay: '2025-06-01',
      scheduledEndDay: monthsOut(2),
    });
  });

  it('opens a renewal of a current Tenancy, naming no tenant', async () => {
    const res = await call('acct-owner', 'POST', renew());
    expect(res.status).toBe(201);
    expect(await requests()).toEqual([
      expect.objectContaining({
        lot_id: 'lot',
        requested_by_person_id: 'owner',
        basis_ownership_id: 'owner-lot-own',
        kind: 'renewal',
        renews_tenancy_id: 'ten',
        tenant_name: null,
        contact_value: null,
        scheduled_end_day: monthsOut(14),
        status: 'open',
      }),
    ]);
  });

  it('measures the end day from where the renewed Tenancy ends', async () => {
    for (const scheduledEndDay of [monthsOut(2), monthsOut(15, 1)]) {
      const res = await call('acct-owner', 'POST', renew({ scheduledEndDay }));
      expect(res.status).toBe(400);
    }
    expect(
      (
        await call(
          'acct-owner',
          'POST',
          renew({ scheduledEndDay: monthsOut(15) }),
        )
      ).status,
    ).toBe(201);
  });

  it('answers the masked 404 for a Tenancy of a Lot the caller does not hold, or none at all', async () => {
    expect((await call('acct-neighbour', 'POST', renew())).status).toBe(404);
    expect(
      (await call('acct-owner', 'POST', renew({ tenancyId: 'nope' }))).status,
    ).toBe(404);
    expect(await requests()).toEqual([]);
  });

  it('answers 409 for a Tenancy that is ended, voided or not yet begun', async () => {
    await seedPerson('p-ended');
    await seedPerson('p-voided');
    await seedPerson('p-upcoming');
    await seedTenancy('ended', {
      tenantPersonId: 'p-ended',
      actualEndDay: '2025-07-01',
    });
    await seedTenancy('voided', { tenantPersonId: 'p-voided', voided: true });
    await seedTenancy('upcoming', {
      tenantPersonId: 'p-upcoming',
      startDay: monthsOut(1),
      scheduledEndDay: monthsOut(6),
    });
    for (const tenancyId of ['ended', 'voided', 'upcoming']) {
      const res = await call('acct-owner', 'POST', renew({ tenancyId }));
      expect(res.status).toBe(409);
    }
    expect(await requests()).toEqual([]);
  });

  it('answers 409 to a second open renewal of the same Tenancy', async () => {
    expect((await call('acct-owner', 'POST', renew())).status).toBe(201);
    expect((await call('acct-owner', 'POST', renew())).status).toBe(409);
    expect(await requests()).toHaveLength(1);
  });

  it('re-checks the Tenancy inside the insert, so one ended mid-request writes nothing', async () => {
    const owner = await deriveAccess(env, 'acct-owner', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(owner, 'POST', renew());
      await paused.reached;
      await getDb(env).run(
        sql`UPDATE tenancies SET actual_end_day = ${today}, end_reason = 'board_ended' WHERE id = 'ten'`,
      );
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await requests()).toEqual([]);
  });

  it('re-checks its basis Ownership inside the insert', async () => {
    // The owner also represents the owning Organization, on whose Ownership
    // the Tenancy rests: voiding the owner's own Ownership leaves them Lot
    // Authority and the Tenancy current, but not the basis the preflight chose.
    await organizationOwning('lot');
    await getDb(env).run(sql`
      INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
      VALUES ('rep-owner', 'owner', 'org', 'organization', '2025-01-01', 1, 1)`);
    await getDb(env).run(
      sql`UPDATE tenancies SET basis_ownership_id = 'org-lot' WHERE id = 'ten'`,
    );
    const owner = await deriveAccess(env, 'acct-owner', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(owner, 'POST', renew());
      await paused.reached;
      await getDb(env).run(
        sql`UPDATE ownerships SET voided_at = 1 WHERE id = 'owner-lot-own'`,
      );
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await requests()).toEqual([]);
  });

  it('re-checks Lot Authority and both gates inside the insert', async () => {
    // A co-owner renews, so ending their Ownership leaves the Tenancy's basis
    // (the first owner's) current: only the requester's authority is lost.
    await seedLotAuthority('co-owner', 'lot', { startDay: '2025-01-01' });
    await account('acct-co', 'co-owner');
    for (const change of [
      () =>
        getDb(env).run(
          sql`UPDATE ownerships SET end_day = ${today} WHERE id = 'co-owner-lot-own'`,
        ),
      () => setGates(true, false),
    ]) {
      await getDb(env).run(
        sql`UPDATE ownerships SET end_day = NULL WHERE id = 'co-owner-lot-own'`,
      );
      await setGates(true, true);
      const coOwner = await deriveAccess(env, 'acct-co', today);
      const paused = pauseNextBatch();
      try {
        const pending = send(coOwner, 'POST', renew());
        await paused.reached;
        await change();
        paused.release();
        expect((await pending).status).toBe(409);
      } finally {
        paused.restore();
      }
    }
    expect(await requests()).toEqual([]);
  });
});

describe('withdraw', () => {
  async function openRequest(): Promise<string> {
    const res = await call('acct-owner', 'POST', newRequest());
    return ((await res.json()) as { id: string }).id;
  }

  it('lets a co-owner withdraw a request someone else made, clearing the name and contact', async () => {
    await seedLotAuthority('co-owner', 'lot', { startDay: '2025-01-01' });
    await account('acct-co', 'co-owner');
    const requestId = await openRequest();
    const res = await call('acct-co', 'POST', {
      action: 'withdraw',
      requestId,
    });
    expect(res.status).toBe(204);
    expect(await requests()).toEqual([
      expect.objectContaining({
        id: requestId,
        status: 'withdrawn',
        requested_by_account_id: 'acct-owner',
        decided_by_account_id: 'acct-co',
        tenant_name: null,
        channel: null,
        contact_value: null,
        contact_normalized: null,
      }),
    ]);
  });

  it('answers the masked 404 outside the caller’s Lots, for an unknown request, or one already decided', async () => {
    const requestId = await openRequest();
    expect(
      (await call('acct-neighbour', 'POST', { action: 'withdraw', requestId }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('acct-owner', 'POST', {
          action: 'withdraw',
          requestId: 'nope',
        })
      ).status,
    ).toBe(404);
    expect(await requests()).toMatchObject([{ status: 'open' }]);
    await call('acct-owner', 'POST', { action: 'withdraw', requestId });
    expect(
      (await call('acct-owner', 'POST', { action: 'withdraw', requestId }))
        .status,
    ).toBe(404);
  });
});

describe('end', () => {
  beforeEach(async () => {
    await seedTenancy('ten', {
      startDay: '2025-06-01',
      scheduledEndDay: monthsOut(6),
    });
  });

  async function ledger(tenancyId: string) {
    const { results } = await env.DATABASE.prepare(
      `SELECT e.event_kind, e.actor_kind, e.actor_account_id, rc.reason_code,
              rc.effective_day, s.role
       FROM roster_change_subjects s
       JOIN audit_events e ON e.id = s.event_id
       JOIN roster_changes rc ON rc.event_id = e.id
       WHERE s.tenancy_id = ?`,
    )
      .bind(tenancyId)
      .all();
    return results;
  }

  it('ends a current Tenancy today as a Roster Change made by the owner', async () => {
    const res = await call('acct-owner', 'POST', {
      action: 'end',
      tenancyId: 'ten',
    });
    expect(res.status).toBe(204);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'owner_ended',
      ended_by_account_id: 'acct-owner',
    });
    expect(await ledger('ten')).toEqual([
      {
        event_kind: 'tenancy_ended',
        actor_kind: 'account',
        actor_account_id: 'acct-owner',
        reason_code: 'owner_ended',
        effective_day: today,
        role: 'ended',
      },
    ]);
  });

  it('ends a Tenancy that has not begun on its start day, so it never runs', async () => {
    await seedPerson('p-upcoming');
    await seedTenancy('upcoming', {
      tenantPersonId: 'p-upcoming',
      startDay: monthsOut(1),
      scheduledEndDay: monthsOut(6),
    });
    const res = await call('acct-owner', 'POST', {
      action: 'end',
      tenancyId: 'upcoming',
    });
    expect(res.status).toBe(204);
    expect(await tenancy('upcoming')).toMatchObject({
      actual_end_day: monthsOut(1),
      end_reason: 'owner_ended',
    });
  });

  it('answers the masked 404 outside the caller’s Lots, or for no Tenancy at all', async () => {
    for (const [acct, tenancyId] of [
      ['acct-neighbour', 'ten'],
      ['acct-owner', 'nope'],
    ])
      expect(
        (await call(acct, 'POST', { action: 'end', tenancyId })).status,
      ).toBe(404);
    expect(await tenancy('ten')).toMatchObject({ actual_end_day: null });
    expect(await ledger('ten')).toEqual([]);
  });

  it('answers 409 for a Tenancy already ended or voided', async () => {
    await seedPerson('p-voided');
    await seedTenancy('voided', { tenantPersonId: 'p-voided', voided: true });
    await call('acct-owner', 'POST', { action: 'end', tenancyId: 'ten' });
    for (const tenancyId of ['ten', 'voided'])
      expect(
        (await call('acct-owner', 'POST', { action: 'end', tenancyId })).status,
      ).toBe(409);
    expect(await ledger('voided')).toEqual([]);
  });

  it('loses to the board ending the same Tenancy first, writing nothing of its own', async () => {
    const owner = await deriveAccess(env, 'acct-owner', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(owner, 'POST', { action: 'end', tenancyId: 'ten' });
      await paused.reached;
      await getDb(env).run(
        sql`UPDATE tenancies SET actual_end_day = ${today}, end_reason = 'board_ended' WHERE id = 'ten'`,
      );
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await tenancy('ten')).toMatchObject({ end_reason: 'board_ended' });
    expect(await ledger('ten')).toEqual([]);
  });

  it('re-checks Lot Authority inside the update', async () => {
    await seedLotAuthority('co-owner', 'lot', { startDay: '2025-01-01' });
    await account('acct-co', 'co-owner');
    const coOwner = await deriveAccess(env, 'acct-co', today);
    const paused = pauseNextBatch();
    try {
      const pending = send(coOwner, 'POST', {
        action: 'end',
        tenancyId: 'ten',
      });
      await paused.reached;
      await getDb(env).run(
        sql`UPDATE ownerships SET end_day = ${today} WHERE id = 'co-owner-lot-own'`,
      );
      paused.release();
      expect((await pending).status).toBe(409);
    } finally {
      paused.restore();
    }
    expect(await tenancy('ten')).toMatchObject({ actual_end_day: null });
    expect(await ledger('ten')).toEqual([]);
  });
});

describe('the owner’s list', () => {
  async function listed() {
    const res = await call('acct-owner', 'GET');
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>[];
  }

  it('lists each of the caller’s Lots with its current and upcoming Tenancies, never ended or voided ones', async () => {
    for (const id of ['p-up', 'p-ended', 'p-voided', 'p-claimed'])
      await seedPerson(id);
    await seedTenancy('current', { scheduledEndDay: monthsOut(6) });
    await seedTenancy('upcoming', {
      tenantPersonId: 'p-up',
      startDay: monthsOut(1),
      scheduledEndDay: monthsOut(6),
    });
    await seedTenancy('ended', {
      tenantPersonId: 'p-ended',
      actualEndDay: '2025-07-01',
    });
    await seedTenancy('voided', { tenantPersonId: 'p-voided', voided: true });
    expect(await listed()).toEqual([
      {
        lotId: 'lot',
        address: 'lot Ashebrook Lane',
        tenancies: [
          {
            id: 'upcoming',
            tenantName: 'Person p-up',
            startDay: monthsOut(1),
            scheduledEndDay: monthsOut(6),
            status: 'upcoming',
            claimed: false,
          },
          {
            id: 'current',
            tenantName: 'Person tenant',
            startDay: '2025-06-01',
            scheduledEndDay: monthsOut(6),
            status: 'current',
            claimed: false,
          },
        ],
        openRequests: [],
        refusedRequests: [],
      },
    ]);
  });

  it('marks a Tenancy claimed once its tenant has a linked Account', async () => {
    await seedTenancy('current', { scheduledEndDay: monthsOut(6) });
    await account('acct-tenant', 'tenant');
    const [lot] = await listed();
    expect(lot.tenancies).toMatchObject([{ id: 'current', claimed: true }]);
  });

  it('shows open requests with only the masked contact', async () => {
    await call('acct-owner', 'POST', newRequest());
    await call(
      'acct-owner',
      'POST',
      newRequest({
        tenantName: 'Sam Sms',
        channel: 'sms',
        contact: '555-555-0142',
      }),
    );
    const [lot] = await listed();
    expect(lot.openRequests).toEqual([
      expect.objectContaining({
        kind: 'new',
        tenantName: 'Tess Tenant',
        channel: 'email',
        contact: '***test',
        scheduledEndDay: monthsOut(12),
        renewsTenancyId: null,
      }),
      expect.objectContaining({
        kind: 'new',
        tenantName: 'Sam Sms',
        channel: 'sms',
        contact: '***0142',
      }),
    ]);
    // Only the last characters: neither the address's start nor its domain.
    expect(JSON.stringify(lot)).not.toMatch(/tess@|example\.test/i);
    expect(JSON.stringify(lot)).not.toContain('555-555-0142');
  });

  it('shows a renewal request under the Tenancy’s tenant', async () => {
    await seedTenancy('current', { scheduledEndDay: monthsOut(6) });
    await call('acct-owner', 'POST', {
      action: 'renew',
      tenancyId: 'current',
      scheduledEndDay: monthsOut(12),
    });
    const [lot] = await listed();
    expect(lot.openRequests).toEqual([
      expect.objectContaining({
        kind: 'renewal',
        tenantName: 'Person tenant',
        channel: null,
        contact: null,
        renewsTenancyId: 'current',
      }),
    ]);
  });

  it('shows refusals from the last 90 days with the board’s reason, and nothing older', async () => {
    const day = 86_400_000;
    for (const [id, ageDays] of [
      ['recent', 10],
      ['old', 91],
    ] as const)
      await env.DATABASE.prepare(
        `INSERT INTO tenancy_requests (id, lot_id, requested_by_account_id,
           requested_by_person_id, basis_ownership_id, kind, scheduled_end_day,
           status, created_at, decided_at, decided_by_account_id, refusal_reason)
         VALUES (?, 'lot', 'acct-owner', 'owner', 'owner-lot-own', 'new', ?,
           'refused', 1, ?, 'board', 'Lease not on file')`,
      )
        .bind(id, monthsOut(6), Date.now() - ageDays * day)
        .run();
    const [lot] = await listed();
    expect(lot.refusedRequests).toEqual([
      {
        id: 'recent',
        kind: 'new',
        scheduledEndDay: monthsOut(6),
        decidedAt: expect.any(Number),
        refusalReason: 'Lease not on file',
      },
    ]);
  });

  it('shows nothing of a Lot the caller does not hold', async () => {
    await seedTenancy('current', { scheduledEndDay: monthsOut(6) });
    await call('acct-owner', 'POST', newRequest());
    const res = await call('acct-neighbour', 'GET');
    expect(await res.json()).toEqual([
      expect.objectContaining({
        lotId: 'other-lot',
        tenancies: [],
        openRequests: [],
        refusedRequests: [],
      }),
    ]);
  });
});

describe('the owner’s list, decided and ended rows', () => {
  it('drops a request once it is withdrawn', async () => {
    const res = await call('acct-owner', 'POST', newRequest());
    const { id } = (await res.json()) as { id: string };
    await call('acct-owner', 'POST', { action: 'withdraw', requestId: id });
    const [lot] = (await (await call('acct-owner', 'GET')).json()) as {
      openRequests: unknown[];
    }[];
    expect(lot.openRequests).toEqual([]);
  });

  it('does not count an ended Account link as claimed', async () => {
    await seedTenancy('current', { scheduledEndDay: monthsOut(6) });
    await account('acct-tenant', 'tenant');
    await env.DATABASE.prepare(
      `UPDATE person_links SET ended_at = 2, ended_by_account_id = 'acct-tenant',
         end_reason = 'self_unlink'
       WHERE account_id = 'acct-tenant'`,
    ).run();
    const [lot] = (await (await call('acct-owner', 'GET')).json()) as {
      tenancies: unknown[];
    }[];
    expect(lot.tenancies).toMatchObject([{ id: 'current', claimed: false }]);
  });
});
