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
import { GET, POST } from '../../src/pages/api/admin/tenancies';
import { associationDateIso } from '../../src/lib/format';
import { callerContext } from './caller-context';
import { pauseNextBatch, req, seedPerson } from './fixtures';
import {
  resetTenancyWorld,
  seedTenancy,
  tenancy,
  tenancyEvents,
} from './tenancy-fixtures';

// #294 slice 2 (ADR 0028, spec decision 3): the board's Tenants panel lists
// every Tenancy and can end or void one. Neither action waits on the
// tenant-access gates, which these tests leave unset (off).

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('board', 'board', []),
}));
afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(resetTenancyWorld);

const URL = 'http://localhost/api/admin/tenancies';
const today = associationDateIso();

async function act(body: Record<string, unknown>): Promise<Response> {
  return POST(req(URL, 'POST', body));
}

async function listed(): Promise<Record<string, unknown>[]> {
  const res = await GET(req(URL, 'GET'));
  expect(res.status).toBe(200);
  return ((await res.json()) as { tenancies: Record<string, unknown>[] })
    .tenancies;
}

describe('the Tenancies list', () => {
  it('names each tenant and Lot, with a status from the one currency rule', async () => {
    for (const id of ['p2', 'p3', 'p4', 'p5']) await seedPerson(id);
    await seedTenancy('current');
    await seedTenancy('upcoming', {
      tenantPersonId: 'p2',
      startDay: '2099-01-01',
      scheduledEndDay: '2099-06-01',
    });
    await seedTenancy('ended', {
      tenantPersonId: 'p3',
      startDay: '2025-02-01',
      scheduledEndDay: '2099-01-01',
      actualEndDay: '2025-05-01',
    });
    await seedTenancy('lapsed', {
      tenantPersonId: 'p4',
      startDay: '2025-02-01',
      scheduledEndDay: '2025-05-01',
    });
    await seedTenancy('voided', { tenantPersonId: 'p5', voided: true });
    const rows = await listed();
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      current: 'current',
      upcoming: 'upcoming',
      ended: 'ended',
      lapsed: 'ended',
      voided: 'voided',
    });
    expect(rows.find((r) => r.id === 'current')).toMatchObject({
      tenantPersonId: 'tenant',
      tenantName: 'Person tenant',
      lotId: 'lot',
      address: 'lot Ashebrook Lane',
      startDay: '2025-06-01',
      scheduledEndDay: '2099-01-01',
      actualEndDay: null,
    });
  });

  it('shows a Tenancy whose basis has ended as ended, before any end is recorded on it', async () => {
    await seedTenancy('current');
    await seedTenancy('upcoming', {
      startDay: '2099-01-01',
      scheduledEndDay: '2099-06-01',
    });
    await env.DATABASE.prepare(
      `UPDATE ownerships SET end_day = '2025-09-01' WHERE id = 'owner-lot-own'`,
    ).run();
    const rows = await listed();
    expect(rows.map((r) => r.status)).toEqual(['ended', 'ended']);
  });
});

describe('ending a Tenancy', () => {
  it('ends it today as board_ended, recorded as the board’s own Roster Change', async () => {
    await seedTenancy('ten');
    expect((await act({ action: 'end', tenancyId: 'ten' })).status).toBe(204);
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'board_ended',
      ended_by_account_id: 'board',
    });
    expect(await tenancyEvents('ten')).toEqual([
      {
        event_kind: 'tenancy_ended',
        actor_kind: 'account',
        automatic_cause: null,
        reason_code: 'board_ended',
        effective_day: today,
        role: 'ended',
      },
    ]);
  });

  it('ends a Tenancy that has not begun on its start day, so it never runs', async () => {
    await seedTenancy('later', {
      startDay: '2099-01-01',
      scheduledEndDay: '2099-06-01',
    });
    expect((await act({ action: 'end', tenancyId: 'later' })).status).toBe(204);
    expect((await tenancy('later')).actual_end_day).toBe('2099-01-01');
  });

  it('refuses a Tenancy already ended, voided or past its end day', async () => {
    for (const id of ['p2', 'p3']) await seedPerson(id);
    await seedTenancy('ended', {
      startDay: '2025-02-01',
      actualEndDay: '2025-03-01',
    });
    await seedTenancy('voided', { tenantPersonId: 'p2', voided: true });
    await seedTenancy('lapsed', {
      tenantPersonId: 'p3',
      startDay: '2025-02-01',
      scheduledEndDay: '2025-03-01',
    });
    for (const id of ['ended', 'voided', 'lapsed'])
      expect((await act({ action: 'end', tenancyId: id })).status).toBe(409);
    expect(
      await (await act({ action: 'end', tenancyId: 'lapsed' })).text(),
    ).toBe('Tenancy has already reached its end day');
    expect((await tenancy('lapsed')).actual_end_day).toBeNull();
  });

  it('answers 404 for a Tenancy that does not exist and 400 without an id', async () => {
    expect((await act({ action: 'end', tenancyId: 'nope' })).status).toBe(404);
    expect((await act({ action: 'end' })).status).toBe(400);
  });

  it('lets only the first of two racing ends land, with one ledger entry', async () => {
    await seedTenancy('ten');
    const barrier = pauseNextBatch();
    const first = act({ action: 'end', tenancyId: 'ten' });
    await barrier.reached;
    barrier.restore();
    expect((await act({ action: 'end', tenancyId: 'ten' })).status).toBe(204);
    barrier.release();
    expect((await first).status).toBe(409);
    expect(await tenancyEvents('ten')).toHaveLength(1);
  });
});

describe('voiding a Tenancy', () => {
  it('voids it as recorded in error', async () => {
    await seedTenancy('ten');
    expect((await act({ action: 'void', tenancyId: 'ten' })).status).toBe(204);
    expect((await tenancy('ten')).voided_at).not.toBeNull();
    expect(await tenancyEvents('ten')).toEqual([
      {
        event_kind: 'tenancy_voided',
        actor_kind: 'account',
        automatic_cause: null,
        reason_code: 'recorded_in_error',
        effective_day: null,
        role: 'voided',
      },
    ]);
  });

  it('voids an ended Tenancy, and refuses a second void', async () => {
    await seedTenancy('ten', {
      startDay: '2025-02-01',
      actualEndDay: '2025-03-01',
    });
    expect((await act({ action: 'void', tenancyId: 'ten' })).status).toBe(204);
    expect((await act({ action: 'void', tenancyId: 'ten' })).status).toBe(409);
    expect(await tenancyEvents('ten')).toHaveLength(1);
  });

  it('lets only the first of two racing voids land, with one ledger entry', async () => {
    await seedTenancy('ten');
    const barrier = pauseNextBatch();
    const first = act({ action: 'void', tenancyId: 'ten' });
    await barrier.reached;
    barrier.restore();
    expect((await act({ action: 'void', tenancyId: 'ten' })).status).toBe(204);
    barrier.release();
    expect((await first).status).toBe(409);
    expect(await tenancyEvents('ten')).toHaveLength(1);
  });

  it('answers 404 for a Tenancy that does not exist', async () => {
    expect((await act({ action: 'void', tenancyId: 'nope' })).status).toBe(404);
  });
});

it('refuses an unknown action', async () => {
  expect((await act({ action: 'transfer' })).status).toBe(400);
});
