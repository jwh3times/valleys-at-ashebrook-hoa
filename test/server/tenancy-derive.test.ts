import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { deriveAccess } from '../../src/server/authz/derive';
import {
  resetRoster,
  seedRoster,
  type RosterSpec,
  type TenancySpec,
} from './dual-fixtures';

// #294 slice 2 (ADR 0028, spec decision 2): a current Tenancy adds the
// `tenant` capability and nothing else. A tenant who owns nothing stays a
// `visitor` for content, holds no Lot and is not a member.

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await resetRoster();
  await env.DATABASE.prepare('DELETE FROM users').run();
});

/** One Lot owned by `owner`, and a tenant Person linked to account `t-acct`. */
function world(tenancy: Partial<TenancySpec> = {}): RosterSpec {
  return {
    lots: [{ id: 'lot-a', owners: [{ id: 'owner', name: 'Olive Owner' }] }],
    people: [{ id: 'tenant', name: 'Tess Tenant' }],
    accounts: [{ id: 't-acct', linkedTo: 'tenant' }],
    tenancies: [
      {
        id: 'ten-1',
        tenantPersonId: 'tenant',
        lotId: 'lot-a',
        basisOwnershipId: 'owner-own',
        startDay: '2026-01-01',
        scheduledEndDay: '2027-01-01',
        ...tenancy,
      },
    ],
  };
}

async function tenantAt(day = DAY): Promise<boolean> {
  return (await deriveAccess(env, 't-acct', day)).capabilities.has('tenant');
}

describe('a current Tenancy', () => {
  it('adds tenant, and leaves the caller a visitor with no Lot', async () => {
    await seedRoster(world());
    const access = await deriveAccess(env, 't-acct', DAY);
    expect([...access.capabilities]).toEqual(['tenant']);
    expect(access.contentTier).toBe('visitor');
    expect(access.lotIds).toEqual([]);
  });

  it('starts on its start day and stops on its scheduled end, which is exclusive', async () => {
    await seedRoster(world());
    expect(await tenantAt('2025-12-31')).toBe(false);
    expect(await tenantAt('2026-01-01')).toBe(true);
    expect(await tenantAt('2026-12-31')).toBe(true);
    expect(await tenantAt('2027-01-01')).toBe(false);
  });

  it('stops on an early end', async () => {
    await seedRoster(world({ actualEndDay: '2026-06-01' }));
    expect(await tenantAt('2026-05-31')).toBe(true);
    expect(await tenantAt()).toBe(false);
  });

  it('grants nothing once voided', async () => {
    await seedRoster(world({ voided: true }));
    expect(await tenantAt()).toBe(false);
  });

  it('grants nothing to an account no longer linked to the tenant', async () => {
    await seedRoster(world());
    await env.DATABASE.prepare(
      `UPDATE person_links SET ended_at = 2 WHERE account_id = 't-acct'`,
    ).run();
    const access = await deriveAccess(env, 't-acct', DAY);
    expect(access.capabilities.size).toBe(0);
  });
});

describe('the basis', () => {
  it('ends the Tenancy on the day its Ownership ends, even with no end recorded on the Tenancy', async () => {
    await seedRoster(world());
    await env.DATABASE.prepare(
      `UPDATE ownerships SET end_day = '2026-06-15' WHERE id = 'owner-own'`,
    ).run();
    expect(await tenantAt('2026-06-14')).toBe(true);
    expect(await tenantAt('2026-06-15')).toBe(false);
  });

  it('grants nothing once its Ownership is voided', async () => {
    await seedRoster(world());
    await env.DATABASE.prepare(
      `UPDATE ownerships SET voided_at = 2 WHERE id = 'owner-own'`,
    ).run();
    expect(await tenantAt()).toBe(false);
  });

  it('grants nothing when the basis Ownership is of another Lot', async () => {
    const spec = world({ lotId: 'lot-b' });
    spec.lots!.push({
      id: 'lot-b',
      owners: [{ id: 'other', name: 'Otto Other' }],
    });
    await seedRoster(spec);
    expect(await tenantAt()).toBe(false);
  });

  it('grants nothing on a retired Lot', async () => {
    await seedRoster(world());
    await env.DATABASE.prepare(
      `UPDATE lots SET retired_at = 99 WHERE id = 'lot-a'`,
    ).run();
    expect(await tenantAt()).toBe(false);
  });
});

describe('who the tenant is', () => {
  it('resolves a consolidated Person to the survivor holding the Tenancy', async () => {
    const spec = world();
    spec.people!.push({ id: 'dup', name: 'Tess Tenant' });
    spec.accounts = [{ id: 't-acct', linkedTo: 'dup' }];
    await seedRoster(spec);
    await env.DATABASE.prepare(
      `UPDATE parties SET consolidated_into_party_id = 'tenant' WHERE id = 'dup'`,
    ).run();
    expect(await tenantAt()).toBe(true);
  });

  it('gives an owner of another Lot both member and tenant, at the homeowner tier', async () => {
    const spec = world({ tenantPersonId: 'owner-b' });
    spec.lots!.push({
      id: 'lot-b',
      owners: [{ id: 'owner-b', name: 'Bea Owner' }],
    });
    spec.accounts = [{ id: 't-acct', linkedTo: 'owner-b' }];
    await seedRoster(spec);
    const access = await deriveAccess(env, 't-acct', DAY);
    expect([...access.capabilities].sort()).toEqual(['member', 'tenant']);
    expect(access.contentTier).toBe('homeowner');
    // The rented Lot never joins the Lots the caller acts for.
    expect(access.lotIds).toEqual(['lot-b']);
  });
});
