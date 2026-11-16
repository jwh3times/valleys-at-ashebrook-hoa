import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { associationDateIso } from '../../src/lib/format';
import { OPERATOR_OBSERVATION } from '../../src/server/roster/audit';
import { endTenancy } from '../../src/server/roster/tenancy-ending';
import { pauseNextBatch, seedLotAuthority, seedPerson } from './fixtures';
import {
  resetTenancyWorld,
  seedLinkedAccount,
  seedTenancy,
  tenancy,
  tenancyEvents,
} from './tenancy-fixtures';

// #599: ending a Tenancy early has one home. A current holder of Lot
// Authority over the Lot or the Board ends it (CONTEXT.md, Tenancy); the
// owner's and the board's routes each turn the outcome into their own answer.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(resetTenancyWorld);

const today = associationDateIso();
const board = {
  kind: 'board',
  accountId: 'board',
  evidence: OPERATOR_OBSERVATION,
} as const;

describe('ending a Tenancy', () => {
  it('ends a current Tenancy today, recorded as one Roster Change by the board', async () => {
    await seedTenancy('ten');
    expect(
      await endTenancy(env.DATABASE, { tenancyId: 'ten', today, by: board }),
    ).toEqual({ ok: true });
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
    expect(
      await endTenancy(env.DATABASE, { tenancyId: 'later', today, by: board }),
    ).toEqual({ ok: true });
    expect((await tenancy('later')).actual_end_day).toBe('2099-01-01');
  });

  it('refuses a Tenancy that does not exist, is voided, has ended or has reached its end day, writing nothing', async () => {
    for (const id of ['p2', 'p3']) await seedPerson(id);
    await seedTenancy('voided', { voided: true });
    await seedTenancy('ended', {
      tenantPersonId: 'p2',
      startDay: '2025-02-01',
      actualEndDay: '2025-03-01',
    });
    await seedTenancy('lapsed', {
      tenantPersonId: 'p3',
      startDay: '2025-02-01',
      scheduledEndDay: today,
    });
    const refusals: Record<string, string> = {
      nope: 'not-found',
      voided: 'voided',
      ended: 'already-ended',
      lapsed: 'end-day-reached',
    };
    for (const [tenancyId, refusal] of Object.entries(refusals))
      expect(
        await endTenancy(env.DATABASE, { tenancyId, today, by: board }),
      ).toEqual({ ok: false, refusal });
    expect((await tenancy('lapsed')).actual_end_day).toBeNull();
    for (const id of ['voided', 'ended', 'lapsed'])
      expect(await tenancyEvents(id)).toEqual([]);
  });
});

describe('ending a Tenancy by Lot Authority', () => {
  const owner = {
    kind: 'lot-authority',
    accountId: 'acct-owner',
    personId: 'owner',
  } as const;

  beforeEach(async () => {
    await seedLinkedAccount('acct-owner', 'owner');
    await seedTenancy('ten');
  });

  it('ends it today as owner_ended, a Roster Change made by the owner’s Account', async () => {
    expect(
      await endTenancy(env.DATABASE, { tenancyId: 'ten', today, by: owner }),
    ).toEqual({ ok: true });
    expect(await tenancy('ten')).toMatchObject({
      actual_end_day: today,
      end_reason: 'owner_ended',
      ended_by_account_id: 'acct-owner',
    });
    expect(await tenancyEvents('ten')).toEqual([
      {
        event_kind: 'tenancy_ended',
        actor_kind: 'account',
        automatic_cause: null,
        reason_code: 'owner_ended',
        effective_day: today,
        role: 'ended',
      },
    ]);
  });

  it('finds no Tenancy on a Lot the person holds no Lot Authority over, even a voided one', async () => {
    await seedPerson('neighbour');
    await seedPerson('p2');
    await seedTenancy('voided', { tenantPersonId: 'p2', voided: true });
    for (const tenancyId of ['ten', 'voided'])
      expect(
        await endTenancy(env.DATABASE, {
          tenancyId,
          today,
          by: { ...owner, personId: 'neighbour' },
        }),
      ).toEqual({ ok: false, refusal: 'not-found' });
    expect(await tenancy('ten')).toMatchObject({ actual_end_day: null });
  });

  it('writes nothing when the Lot Authority ends before the write lands', async () => {
    await seedLotAuthority('co-owner', 'lot', { startDay: '2025-01-01' });
    const paused = pauseNextBatch();
    try {
      const pending = endTenancy(env.DATABASE, {
        tenancyId: 'ten',
        today,
        by: { ...owner, personId: 'co-owner' },
      });
      await paused.reached;
      await env.DATABASE.prepare(
        `UPDATE ownerships SET end_day = ? WHERE id = 'co-owner-lot-own'`,
      )
        .bind(today)
        .run();
      paused.release();
      expect(await pending).toEqual({ ok: false, refusal: 'lost-race' });
    } finally {
      paused.restore();
    }
    expect(await tenancy('ten')).toMatchObject({ actual_end_day: null });
    expect(await tenancyEvents('ten')).toEqual([]);
  });
});
