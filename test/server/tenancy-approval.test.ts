import { env, applyD1Migrations } from 'cloudflare:test';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { sql } from 'drizzle-orm';
import { GET, POST } from '../../src/pages/api/admin/tenancies';
import { associationDateIso } from '../../src/lib/format';
import { getDb } from '../../src/server/db/client';
import { callerContext } from './caller-context';
import { pauseNextBatch, req, seedPerson, seedProperty } from './fixtures';
import { resetTenancyWorld, seedTenancy } from './tenancy-fixtures';

// #294 slice 3 (ADR 0028, spec decision 3): the board approves or refuses an
// owner's request. Approval is one batch that records the Tenancy, and the
// Person and Contact Method it needs, only if every re-check still holds;
// any that fails answers 409 with its reason and writes nothing. Refusal
// records the reason and clears the tenant's name and contact.

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('board', 'board', []),
}));
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const URL = 'http://localhost/api/admin/tenancies';
const today = associationDateIso();

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

/** An open request on `lot` by `owner`, on Ownership `owner-lot-own`. */
async function seedRequest(
  id: string,
  overrides: Record<string, string | number | null> = {},
) {
  const row: Record<string, string | number | null> = {
    id,
    lot_id: 'lot',
    requested_by_account_id: 'acct-owner',
    requested_by_person_id: 'owner',
    basis_ownership_id: 'owner-lot-own',
    kind: 'new',
    tenant_name: 'Tess Tenant',
    channel: 'email',
    contact_value: 'Tess@Example.test',
    contact_normalized: 'tess@example.test',
    scheduled_end_day: monthsOut(12),
    created_at: 1,
    ...overrides,
  };
  const names = Object.keys(row);
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_requests (${names.join(', ')})
     VALUES (${names.map(() => '?').join(', ')})`,
  )
    .bind(...names.map((n) => row[n]))
    .run();
}

const RENEWAL = {
  kind: 'renewal',
  tenant_name: null,
  channel: null,
  contact_value: null,
  contact_normalized: null,
};

async function act(body: Record<string, unknown>): Promise<Response> {
  return POST(req(URL, 'POST', body));
}

async function request(id: string) {
  return env.DATABASE.prepare('SELECT * FROM tenancy_requests WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
}

async function count(table: string): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS n FROM ${table}`,
  ).first<{ n: number }>();
  return row!.n;
}

/** Every ledger row of the approval's correlation, in order. */
async function approvalLedger() {
  const { results } = await env.DATABASE.prepare(
    `SELECT e.event_kind, e.correlation_sequence, rc.reason_code,
            rc.evidence_kind, rc.evidence_request_id, rc.effective_day
     FROM audit_events e JOIN roster_changes rc ON rc.event_id = e.id
     WHERE e.correlation_id IN (
       SELECT correlation_id FROM audit_events
       WHERE operation_key LIKE 'tenancies:approve:%'
     )
     ORDER BY e.correlation_sequence`,
  ).all();
  return results;
}

beforeEach(async () => {
  await resetTenancyWorld();
  await env.DATABASE.prepare('DELETE FROM settings').run();
  await setGates(true, true);
});

describe('approve a new request', () => {
  it('creates the tenant from the request, with the requested contact, and records the Tenancy from today', async () => {
    await seedRequest('req');
    const res = await act({ action: 'approve', requestId: 'req' });
    expect(res.status).toBe(201);
    const { tenancyId, personId } = (await res.json()) as {
      tenancyId: string;
      personId: string;
    };

    expect(
      await env.DATABASE.prepare(
        `SELECT full_name FROM people WHERE party_id = ?`,
      )
        .bind(personId)
        .first(),
    ).toEqual({ full_name: 'Tess Tenant' });
    expect(
      await env.DATABASE.prepare(
        `SELECT channel, value, value_normalized, is_preferred
         FROM contact_methods WHERE party_id = ?`,
      )
        .bind(personId)
        .all(),
    ).toMatchObject({
      results: [
        {
          channel: 'email',
          value: 'Tess@Example.test',
          value_normalized: 'tess@example.test',
          is_preferred: 1,
        },
      ],
    });
    expect(
      await env.DATABASE.prepare(
        `SELECT tenant_person_id, lot_id, basis_ownership_id, start_day,
                scheduled_end_day, renews_tenancy_id
         FROM tenancies WHERE id = ?`,
      )
        .bind(tenancyId)
        .first(),
    ).toEqual({
      tenant_person_id: personId,
      lot_id: 'lot',
      basis_ownership_id: 'owner-lot-own',
      start_day: today,
      scheduled_end_day: monthsOut(12),
      renews_tenancy_id: null,
    });
    expect(await request('req')).toMatchObject({
      status: 'approved',
      tenancy_id: tenancyId,
      decided_by_account_id: 'board',
      tenant_name: null,
      channel: null,
      contact_value: null,
      contact_normalized: null,
    });
  });

  it('records the Person, the Contact Method and the Tenancy as one correlation citing the request', async () => {
    await seedRequest('req');
    await act({ action: 'approve', requestId: 'req' });
    expect(await approvalLedger()).toEqual([
      {
        event_kind: 'person_created',
        correlation_sequence: 0,
        reason_code: 'tenancy_request_approved',
        evidence_kind: 'request',
        evidence_request_id: 'req',
        effective_day: today,
      },
      {
        event_kind: 'contact_method_recorded',
        correlation_sequence: 1,
        reason_code: 'tenancy_request_approved',
        evidence_kind: 'request',
        evidence_request_id: 'req',
        effective_day: today,
      },
      {
        event_kind: 'tenancy_recorded',
        correlation_sequence: 2,
        reason_code: 'tenancy_request_approved',
        evidence_kind: 'request',
        evidence_request_id: 'req',
        effective_day: today,
      },
    ]);
  });

  it('names an existing Person instead, adding the contact they lack', async () => {
    await seedRequest('req');
    const res = await act({
      action: 'approve',
      requestId: 'req',
      personId: 'tenant',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ personId: 'tenant' });
    expect(
      await env.DATABASE.prepare(
        `SELECT value_normalized, is_preferred FROM contact_methods WHERE party_id = 'tenant'`,
      ).all(),
    ).toMatchObject({
      results: [{ value_normalized: 'tess@example.test', is_preferred: 0 }],
    });
    expect((await approvalLedger()).map((e) => e.event_kind)).toEqual([
      'contact_method_recorded',
      'tenancy_recorded',
    ]);
  });

  it('adds no contact to an existing Person who already holds it', async () => {
    await env.DATABASE.prepare(
      `INSERT INTO contact_methods (id, party_id, party_kind, channel, value,
         value_normalized, is_preferred, created_at, updated_at)
       VALUES ('cm', 'tenant', 'person', 'email', 'tess@example.test',
         'tess@example.test', 1, 1, 1)`,
    ).run();
    await seedRequest('req');
    await act({ action: 'approve', requestId: 'req', personId: 'tenant' });
    expect(await count('contact_methods')).toBe(1);
    expect((await approvalLedger()).map((e) => e.event_kind)).toEqual([
      'tenancy_recorded',
    ]);
  });

  it('answers 404 for an unknown request or Person, writing nothing', async () => {
    await seedRequest('req');
    expect((await act({ action: 'approve', requestId: 'nope' })).status).toBe(
      404,
    );
    expect(
      (await act({ action: 'approve', requestId: 'req', personId: 'nope' }))
        .status,
    ).toBe(404);
    expect(await count('tenancies')).toBe(0);
    expect(await request('req')).toMatchObject({ status: 'open' });
  });
});

describe('approve a renewal', () => {
  it('starts the new Tenancy where the renewed one is scheduled to end, for the same tenant', async () => {
    await seedTenancy('old', { scheduledEndDay: monthsOut(2) });
    await seedRequest('req', {
      ...RENEWAL,
      renews_tenancy_id: 'old',
      scheduled_end_day: monthsOut(14),
    });
    const res = await act({ action: 'approve', requestId: 'req' });
    expect(res.status).toBe(201);
    const { tenancyId } = (await res.json()) as { tenancyId: string };
    expect(
      await env.DATABASE.prepare(
        `SELECT tenant_person_id, start_day, scheduled_end_day, renews_tenancy_id
         FROM tenancies WHERE id = ?`,
      )
        .bind(tenancyId)
        .first(),
    ).toEqual({
      tenant_person_id: 'tenant',
      start_day: monthsOut(2),
      scheduled_end_day: monthsOut(14),
      renews_tenancy_id: 'old',
    });
    expect((await approvalLedger()).map((e) => e.event_kind)).toEqual([
      'tenancy_recorded',
    ]);
  });

  it('starts today when the renewed Tenancy’s end day has already passed', async () => {
    await seedTenancy('old', {
      startDay: '2025-02-01',
      scheduledEndDay: '2025-08-01',
    });
    await seedRequest('req', {
      ...RENEWAL,
      renews_tenancy_id: 'old',
      scheduled_end_day: monthsOut(6),
    });
    const res = await act({ action: 'approve', requestId: 'req' });
    const { tenancyId } = (await res.json()) as { tenancyId: string };
    expect(
      await env.DATABASE.prepare(`SELECT start_day FROM tenancies WHERE id = ?`)
        .bind(tenancyId)
        .first(),
    ).toEqual({ start_day: today });
  });

  it('refuses to name a Person for a renewal', async () => {
    await seedTenancy('old', { scheduledEndDay: monthsOut(2) });
    await seedRequest('req', { ...RENEWAL, renews_tenancy_id: 'old' });
    const res = await act({
      action: 'approve',
      requestId: 'req',
      personId: 'owner',
    });
    expect(res.status).toBe(400);
  });
});

describe('every approval re-check', () => {
  async function expectRefused(reason: string, personId?: string) {
    const res = await act({ action: 'approve', requestId: 'req', personId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason });
    expect(await count('tenancies')).toBe(
      reason === 'overlap' || reason === 'renewed-ended' ? 1 : 0,
    );
    expect(await approvalLedger()).toEqual([]);
    expect(
      await env.DATABASE.prepare(
        `SELECT COUNT(*) AS n FROM people WHERE full_name = 'Tess Tenant'`,
      ).first(),
    ).toEqual({ n: 0 });
  }

  it('already-decided: the request is no longer open', async () => {
    await seedRequest('req', {
      tenant_name: null,
      channel: null,
      contact_value: null,
      contact_normalized: null,
      status: 'withdrawn',
      decided_at: 1,
      decided_by_account_id: 'acct-owner',
    });
    await expectRefused('already-decided');
  });

  it('basis-ended: the basis Ownership has ended, been voided, or its Lot retired', async () => {
    for (const change of [
      `UPDATE ownerships SET end_day = '${today}' WHERE id = 'owner-lot-own'`,
      `UPDATE ownerships SET voided_at = 1 WHERE id = 'owner-lot-own'`,
      `UPDATE lots SET retired_at = 1 WHERE id = 'lot'`,
    ]) {
      await resetTenancyWorld();
      await setGates(true, true);
      await seedRequest('req');
      await env.DATABASE.prepare(change).run();
      await expectRefused('basis-ended');
    }
  });

  it('requester-lost-authority: the requester no longer holds the Lot, though the basis stands', async () => {
    // A Representative requested on the Organization's Ownership, then their
    // Representation ended: the basis is still current.
    await seedProperty('org-lot');
    await getDb(env).run(sql`
      INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org', 'organization', 1, 1)`);
    await getDb(env).run(sql`
      INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
      VALUES ('org', 'organization', 'Example Holdings LLC', 'example holdings llc', 1)`);
    await getDb(env).run(sql`
      INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
      VALUES ('org-own', 'org', 'org-lot', '2025-01-01', 1, 1)`);
    await seedPerson('rep');
    await getDb(env).run(sql`
      INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, end_day, created_at, updated_at)
      VALUES ('rep-1', 'rep', 'org', 'organization', '2025-01-01', ${today}, 1, 1)`);
    await seedRequest('req', {
      lot_id: 'org-lot',
      requested_by_person_id: 'rep',
      basis_ownership_id: 'org-own',
    });
    await expectRefused('requester-lost-authority');
  });

  it('gates-off: either gate is off', async () => {
    await seedRequest('req');
    const paused = pauseNextBatch();
    try {
      const pending = act({ action: 'approve', requestId: 'req' });
      await paused.reached;
      await setGates(true, false);
      paused.release();
      const res = await pending;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'gates-off' });
    } finally {
      paused.restore();
    }
    expect(await count('tenancies')).toBe(0);
    expect(await approvalLedger()).toEqual([]);
  });

  it('not-board: the caller no longer has Board Access', async () => {
    await seedRequest('req');
    await env.DATABASE.prepare(
      `UPDATE access_grants SET ended_at = started_at + 1, ended_by_account_id = 'board',
         end_reason = 'revoked' WHERE id = 'operator-grant'`,
    ).run();
    await expectRefused('not-board');
  });

  it('end-day-passed: the requested end is no later than the start', async () => {
    await seedRequest('req', { scheduled_end_day: today });
    await expectRefused('end-day-passed');
  });

  it('end-day-too-far: the requested end is more than 13 months after the start', async () => {
    await seedRequest('req', { scheduled_end_day: monthsOut(13, 1) });
    await expectRefused('end-day-too-far');
  });

  it('overlap: the named Person already rents the Lot for an overlapping period', async () => {
    await seedTenancy('existing', { scheduledEndDay: monthsOut(3) });
    await seedRequest('req');
    await expectRefused('overlap', 'tenant');
  });

  it('renewed-ended: the Tenancy a renewal renews has been ended', async () => {
    await seedTenancy('old', {
      scheduledEndDay: monthsOut(2),
      actualEndDay: '2025-07-01',
    });
    await seedRequest('req', { ...RENEWAL, renews_tenancy_id: 'old' });
    await expectRefused('renewed-ended');
  });

  it('person-consolidated: the named Person was consolidated into another', async () => {
    await seedPerson('survivor');
    await env.DATABASE.prepare(
      `UPDATE parties SET consolidated_into_party_id = 'survivor' WHERE id = 'tenant'`,
    ).run();
    await seedRequest('req');
    await expectRefused('person-consolidated', 'tenant');
  });

  it('lets only one of two concurrent approvals through', async () => {
    await seedRequest('req');
    const paused = pauseNextBatch();
    let first: Promise<Response>;
    try {
      first = act({ action: 'approve', requestId: 'req' });
      await paused.reached;
      paused.restore();
      expect((await act({ action: 'approve', requestId: 'req' })).status).toBe(
        201,
      );
      paused.release();
      const res = await first;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'already-decided' });
    } finally {
      paused.restore();
    }
    expect(await count('tenancies')).toBe(1);
    expect(
      await env.DATABASE.prepare(
        `SELECT COUNT(*) AS n FROM people WHERE full_name = 'Tess Tenant'`,
      ).first(),
    ).toEqual({ n: 1 });
  });
});

describe('refuse', () => {
  it('records the reason and clears the name and contact, with no ledger row', async () => {
    await seedRequest('req');
    const res = await act({
      action: 'refuse',
      requestId: 'req',
      reason: 'No lease on file',
    });
    expect(res.status).toBe(204);
    expect(await request('req')).toMatchObject({
      status: 'refused',
      refusal_reason: 'No lease on file',
      decided_by_account_id: 'board',
      tenant_name: null,
      channel: null,
      contact_value: null,
      contact_normalized: null,
    });
    expect(await count('audit_events')).toBe(0);
  });

  it('requires a reason', async () => {
    await seedRequest('req');
    expect(
      (await act({ action: 'refuse', requestId: 'req', reason: '  ' })).status,
    ).toBe(400);
    expect(await request('req')).toMatchObject({ status: 'open' });
  });

  it('re-checks Board Access inside the update, writing nothing without it', async () => {
    await seedRequest('req');
    await env.DATABASE.prepare(
      `UPDATE access_grants SET ended_at = started_at + 1, ended_by_account_id = 'board',
         end_reason = 'revoked' WHERE id = 'operator-grant'`,
    ).run();
    const res = await act({ action: 'refuse', requestId: 'req', reason: 'x' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('You no longer have board access');
    expect(await request('req')).toMatchObject({
      status: 'open',
      tenant_name: 'Tess Tenant',
    });
  });

  it('answers 404 for an unknown request and 409 for one already decided', async () => {
    await seedRequest('req');
    expect(
      (await act({ action: 'refuse', requestId: 'nope', reason: 'x' })).status,
    ).toBe(404);
    await act({ action: 'refuse', requestId: 'req', reason: 'x' });
    expect(
      (await act({ action: 'refuse', requestId: 'req', reason: 'y' })).status,
    ).toBe(409);
    expect(await request('req')).toMatchObject({ refusal_reason: 'x' });
  });
});

describe('the gates', () => {
  it('answers 404 to approve while either gate is off, but still refuses, ends and voids', async () => {
    for (const [official, tenant] of [
      [false, true],
      [true, false],
    ] as const) {
      await resetTenancyWorld();
      await seedRequest('req');
      await seedTenancy('ten');
      await setGates(official, tenant);
      expect((await act({ action: 'approve', requestId: 'req' })).status).toBe(
        404,
      );
      expect(await count('tenancies')).toBe(1);
      expect(
        (await act({ action: 'refuse', requestId: 'req', reason: 'x' })).status,
      ).toBe(204);
      expect(await request('req')).toMatchObject({
        status: 'refused',
        tenant_name: null,
        contact_value: null,
      });
      expect((await act({ action: 'end', tenancyId: 'ten' })).status).toBe(204);
      expect((await act({ action: 'void', tenancyId: 'ten' })).status).toBe(
        204,
      );
    }
  });

  it('tells the panel whether approval is open', async () => {
    const approvalOpen = async () =>
      ((await (await GET(req(URL, 'GET'))).json()) as { approvalOpen: boolean })
        .approvalOpen;
    expect(await approvalOpen()).toBe(true);
    await setGates(false, true);
    expect(await approvalOpen()).toBe(false);
    await setGates(true, false);
    expect(await approvalOpen()).toBe(false);
  });
});

describe('the board’s queue', () => {
  async function queue() {
    const res = await GET(req(URL, 'GET'));
    expect(res.status).toBe(200);
    return ((await res.json()) as { requests: Record<string, unknown>[] })
      .requests;
  }

  it('lists each open request with its requester, Lot, tenant and full contact', async () => {
    await seedRequest('req', { created_at: 5 });
    await seedRequest('decided', {
      tenant_name: null,
      channel: null,
      contact_value: null,
      contact_normalized: null,
      status: 'withdrawn',
      decided_at: 6,
      decided_by_account_id: 'acct-owner',
    });
    expect(await queue()).toEqual([
      {
        id: 'req',
        kind: 'new',
        lotId: 'lot',
        address: 'lot Ashebrook Lane',
        requesterName: 'Person owner',
        tenantName: 'Tess Tenant',
        channel: 'email',
        contact: 'Tess@Example.test',
        scheduledEndDay: monthsOut(12),
        renewsTenancyId: null,
        createdAt: 5,
        basisEnded: false,
        candidates: [],
      },
    ]);
  });

  it('marks a request whose basis has ended, so the panel offers only Refuse', async () => {
    for (const change of [
      `UPDATE ownerships SET end_day = '${today}' WHERE id = 'owner-lot-own'`,
      `UPDATE ownerships SET voided_at = 1 WHERE id = 'owner-lot-own'`,
      `UPDATE lots SET retired_at = 1 WHERE id = 'lot'`,
    ]) {
      await resetTenancyWorld();
      await setGates(true, true);
      await seedRequest('req');
      expect(await queue()).toMatchObject([{ id: 'req', basisEnded: false }]);
      await env.DATABASE.prepare(change).run();
      expect(await queue()).toMatchObject([{ id: 'req', basisEnded: true }]);
    }
  });

  it('offers each Person matching the tenant’s name or already holding the contact', async () => {
    await seedPerson('same-name', {
      fullName: 'Tess Tenant',
      nameNormalized: 'tess tenant',
    });
    await seedPerson('holds-contact', {
      fullName: 'Tessa T.',
      nameNormalized: 'tessa t',
    });
    await seedPerson('merged', {
      fullName: 'Tess Tenant',
      nameNormalized: 'tess tenant',
    });
    await env.DATABASE.prepare(
      `UPDATE parties SET consolidated_into_party_id = 'same-name' WHERE id = 'merged'`,
    ).run();
    await env.DATABASE.prepare(
      `INSERT INTO contact_methods (id, party_id, party_kind, channel, value,
         value_normalized, is_preferred, created_at, updated_at)
       VALUES ('cm', 'holds-contact', 'person', 'email', 'TESS@example.test',
         'tess@example.test', 0, 1, 1)`,
    ).run();
    await seedRequest('req');
    const [row] = await queue();
    expect(row.candidates).toEqual([
      { personId: 'holds-contact', name: 'Tessa T.', matchedBy: 'contact' },
      { personId: 'same-name', name: 'Tess Tenant', matchedBy: 'name' },
    ]);
  });

  it('names the renewed Tenancy’s tenant on a renewal, with no candidates', async () => {
    await seedTenancy('old', { scheduledEndDay: monthsOut(2) });
    await seedRequest('req', { ...RENEWAL, renews_tenancy_id: 'old' });
    expect(await queue()).toMatchObject([
      {
        kind: 'renewal',
        tenantName: 'Person tenant',
        contact: null,
        renewsTenancyId: 'old',
        candidates: [],
      },
    ]);
  });
});
