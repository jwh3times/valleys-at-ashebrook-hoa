import { env, applyD1Migrations } from 'cloudflare:test';
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { POST as ownershipsPost } from '../../src/pages/api/admin/roster-ownerships';
import { POST as lotsPost } from '../../src/pages/api/admin/roster-lots';
import { POST as representationsPost } from '../../src/pages/api/admin/roster-representations';
import { associationDateIso } from '../../src/lib/format';
import type { OwnershipTransferPreview } from '../../src/lib/ownership-transfer';
import { callerContext } from './caller-context';
import { pauseNextBatch, req, seedLotAuthority, seedPerson } from './fixtures';
import {
  resetTenancyWorld,
  seedTenancy,
  tenancy,
  tenancyEvents,
} from './tenancy-fixtures';

// #294 slice 2 (ADR 0028, spec decision 7): every path that ends an Ownership
// also ends the Tenancies resting on it, in the same batch, as caused Roster
// Changes. A Tenancy ends on the later of its start and the day the basis
// ended, so one that had not begun ends on its start day and never runs.

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('board', 'board', []),
}));
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(resetTenancyWorld);

const today = associationDateIso();
const OWNERSHIPS = 'http://localhost/api/admin/roster-ownerships';
const LOTS = 'http://localhost/api/admin/roster-lots';

async function ownerships(body: Record<string, unknown>): Promise<Response> {
  return ownershipsPost(req(OWNERSHIPS, 'POST', body));
}

describe('ending an Ownership', () => {
  it('ends no Tenancy when the end loses a race', async () => {
    await seedTenancy('ten');
    const barrier = pauseNextBatch();
    const pending = ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: today,
    });
    await barrier.reached;
    barrier.restore();
    // Someone else ends the Ownership first; their command, not this one,
    // owns the consequences.
    await env.DATABASE.prepare(
      `UPDATE ownerships SET end_day = ? WHERE id = 'owner-lot-own'`,
    )
      .bind(today)
      .run();
    barrier.release();
    expect((await pending).status).toBe(409);
    expect((await tenancy('ten')).actual_end_day).toBeNull();
    expect(await tenancyEvents('ten')).toEqual([]);
  });

  it('ends a current Tenancy on the Ownership end day, as a caused Roster Change', async () => {
    await seedTenancy('ten');
    const res = await ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: today,
    });
    expect(res.status).toBe(204);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'basis_ended',
      ended_by_account_id: 'board',
    });
    expect(await tenancyEvents('ten')).toEqual([
      {
        event_kind: 'tenancy_ended',
        actor_kind: 'automatic',
        automatic_cause: 'ownership_ended',
        reason_code: 'basis_ended',
        effective_day: today,
        role: 'ended',
      },
    ]);
  });

  it('keeps an end the board recorded while the Ownership end was in flight', async () => {
    await seedTenancy('ten');
    const barrier = pauseNextBatch();
    const pending = ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: today,
    });
    await barrier.reached;
    barrier.restore();
    await env.DATABASE.prepare(
      `UPDATE tenancies SET actual_end_day = '2025-07-01', end_reason = 'board_ended' WHERE id = 'ten'`,
    ).run();
    barrier.release();
    expect((await pending).status).toBe(204);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: '2025-07-01',
      end_reason: 'board_ended',
    });
    expect(await tenancyEvents('ten')).toEqual([]);
  });

  it('ends a backdated Tenancy on the backdated day', async () => {
    await seedTenancy('ten');
    await ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: '2025-09-01',
    });
    expect((await tenancy('ten')).actual_end_day).toBe('2025-09-01');
  });

  it('ends a Tenancy that had not begun on its own start day', async () => {
    await seedTenancy('later', { startDay: '2025-10-01' });
    await ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: '2025-09-01',
    });
    expect((await tenancy('later')).actual_end_day).toBe('2025-10-01');
  });

  it('leaves alone a Tenancy that had already ended, lapsed or been voided', async () => {
    await seedTenancy('ended', {
      startDay: '2025-02-01',
      scheduledEndDay: '2025-12-01',
      actualEndDay: '2025-03-01',
    });
    await seedPerson('other');
    await seedTenancy('lapsed', {
      tenantPersonId: 'other',
      startDay: '2025-02-01',
      scheduledEndDay: '2025-08-01',
    });
    await seedPerson('third');
    await seedTenancy('voided', { tenantPersonId: 'third', voided: true });
    await ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: '2025-09-01',
    });
    expect((await tenancy('ended')).actual_end_day).toBe('2025-03-01');
    expect((await tenancy('lapsed')).actual_end_day).toBeNull();
    expect((await tenancy('voided')).actual_end_day).toBeNull();
    expect(await tenancyEvents('lapsed')).toEqual([]);
  });

  it("leaves a co-owner's Tenancy alone", async () => {
    await seedLotAuthority('co', 'lot', { startDay: '2025-01-01' });
    await seedTenancy('cos', { basisOwnershipId: 'co-lot-own' });
    await ownerships({
      action: 'end',
      ownershipId: 'owner-lot-own',
      endDay: today,
    });
    expect((await tenancy('cos')).actual_end_day).toBeNull();
  });
});

describe('voiding an Ownership', () => {
  it('ends the Tenancy today: the access it gave really ran until the error was found', async () => {
    await seedTenancy('ten');
    const res = await ownerships({
      action: 'void',
      ownershipId: 'owner-lot-own',
    });
    expect(res.status).toBe(204);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'basis_ended',
      voided_at: null,
    });
    expect(await tenancyEvents('ten')).toMatchObject([
      { event_kind: 'tenancy_ended', automatic_cause: 'ownership_voided' },
    ]);
  });
});

describe('transferring an Ownership', () => {
  const input = {
    lotId: 'lot',
    departingOwnershipIds: ['owner-lot-own'],
    incomingPartyIds: ['buyer'],
    effectiveDay: today,
  };
  beforeEach(() => seedPerson('buyer'));

  async function preview(): Promise<OwnershipTransferPreview> {
    const res = await ownerships({ action: 'previewTransfer', ...input });
    if (res.status !== 200) throw new Error(await res.text());
    return res.json();
  }

  it('names only the Tenancies still running, never a voided, ended or lapsed one', async () => {
    for (const id of ['p2', 'p3', 'p4']) await seedPerson(id);
    await seedTenancy('running');
    await seedTenancy('voided', { tenantPersonId: 'p2', voided: true });
    await seedTenancy('ended', {
      tenantPersonId: 'p3',
      startDay: '2025-02-01',
      actualEndDay: '2025-03-01',
    });
    await seedTenancy('lapsed', {
      tenantPersonId: 'p4',
      startDay: '2025-02-01',
      scheduledEndDay: '2025-03-01',
    });
    expect((await preview()).tenanciesEnding.map((t) => t.tenancyId)).toEqual([
      'running',
    ]);
  });

  it('names each Tenancy it will end, and ends it on the effective day', async () => {
    await seedTenancy('ten', { scheduledEndDay: '2099-01-01' });
    const review = await preview();
    expect(review.tenanciesEnding).toEqual([
      {
        tenancyId: 'ten',
        personId: 'tenant',
        displayName: 'Person tenant',
        scheduledEndDay: '2099-01-01',
      },
    ]);
    expect((await tenancy('ten')).actual_end_day).toBeNull();
    const res = await ownerships({
      action: 'transfer',
      ...input,
      previewToken: review.token,
    });
    expect(res.status).toBe(200);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'basis_ended',
    });
  });

  it('refuses a preview made before a Tenancy was recorded', async () => {
    const review = await preview();
    expect(review.tenanciesEnding).toEqual([]);
    await seedTenancy('ten');
    const res = await ownerships({
      action: 'transfer',
      ...input,
      previewToken: review.token,
    });
    expect(res.status).toBe(409);
    expect((await tenancy('ten')).actual_end_day).toBeNull();
  });
});

describe('retiring a Lot', () => {
  it('ends every Tenancy of the Lot on the retirement day, as lot_retired', async () => {
    await seedTenancy('ten');
    const res = await lotsPost(
      req(LOTS, 'POST', { action: 'retire', lotId: 'lot' }),
    );
    expect(res.status).toBe(204);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'lot_retired',
    });
    expect(await tenancyEvents('ten')).toMatchObject([
      {
        event_kind: 'tenancy_ended',
        automatic_cause: 'lot_retired',
        reason_code: 'lot_retired',
      },
    ]);
  });
});

describe('ending a Representation', () => {
  it('changes no Tenancy: the basis is the Organization’s Ownership', async () => {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org', 'organization', 1, 1)`,
      ),
      env.DATABASE.prepare(
        `INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
         VALUES ('org', 'organization', 'Example Holdings LLC', 'example holdings llc', 1)`,
      ),
      env.DATABASE.prepare(
        `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
         VALUES ('org-own', 'org', 'lot', '2025-01-01', 1, 1)`,
      ),
      env.DATABASE.prepare(
        `INSERT INTO representations (id, representative_person_id, organization_party_id, scope_kind, start_day, created_at, updated_at)
         VALUES ('rep', 'owner', 'org', 'organization', '2025-01-01', 1, 1)`,
      ),
    ]);
    await seedTenancy('ten', { basisOwnershipId: 'org-own' });
    const res = await representationsPost(
      req('http://localhost/api/admin/roster-representations', 'POST', {
        action: 'end',
        representationId: 'rep',
      }),
    );
    expect(res.status).toBe(204);
    expect((await tenancy('ten')).actual_end_day).toBeNull();
  });
});
