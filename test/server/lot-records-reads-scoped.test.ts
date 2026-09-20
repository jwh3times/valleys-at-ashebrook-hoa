import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as lotRecords from '../../src/server/lot-records/reads';
import { truncateAll, seedProperty, seedLotAuthority } from './fixtures';
import { getDb } from '../../src/server/db/client';
import { lotViolations, lotRecordEvents } from '../../src/server/db/schema';
import {
  parties,
  people,
  organizations,
  ownerships,
  representations,
  representationLots,
} from '../../src/server/db/roster-schema';
import { LOT_RECORD_TYPES, DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import {
  LOT_RECORDS_ENABLED_SQL,
  lotRecordsAvailable,
} from '../../src/server/lot-records/gate';
import { settings } from '../../src/server/db/schema';

/**
 * The Lot Record audience, proved against seeded roster facts (ADR 0024, #291).
 *
 * This is the sibling of `reads-all-scoped.test.ts` for a second scoping axis.
 * That suite proves tier filtering; this one proves the thing a tier cannot
 * express: a row belongs to ONE Lot, and only the parties holding authority
 * over that Lot may read it.
 *
 * `permission-matrix.test.ts` seeds capability sets with a synthetic `lotIds`,
 * which proves the GATE. It cannot prove the SCOPE, because the scope is a
 * roster join rather than a capability. So every case below seeds real
 * Ownerships and Representations and asks what the query returns — a caller
 * with authority over Lot A must see nothing of Lot B, whatever their role.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const DAY = '2026-09-20';

async function seedViolation(
  id: string,
  lotId: string,
  overrides: {
    effectiveDay?: string;
    status?: 'open' | 'cured' | 'closed' | 'voided';
    internalNote?: string | null;
    category?: 'architectural' | 'parking' | 'other';
  } = {},
) {
  await getDb(env)
    .insert(lotViolations)
    .values({
      id,
      lotId,
      category: overrides.category ?? 'parking',
      effectiveDay: overrides.effectiveDay ?? '2026-09-01',
      summary: `Violation ${id}`,
      internalNote: overrides.internalNote ?? null,
      status: overrides.status ?? 'open',
      createdBy: 'board-account',
      createdAt: new Date('2026-09-01T12:00:00Z'),
    });
}

/** An Organization owning a Lot, represented by a Person. */
async function seedOrganizationAuthority(
  personId: string,
  orgId: string,
  lotId: string,
  opts: {
    scopeKind?: 'organization' | 'lots';
    representationStartDay?: string;
    ownershipStartDay?: string | null;
  } = {},
) {
  const db = getDb(env);
  const now = new Date('2026-01-01T00:00:00Z');
  await db.insert(parties).values({
    id: orgId,
    kind: 'organization',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(organizations).values({
    partyId: orgId,
    partyKind: 'organization',
    legalName: `Org ${orgId}`,
    nameNormalized: `org ${orgId}`,
    updatedAt: now,
  });
  await db.insert(parties).values({
    id: personId,
    kind: 'person',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(people).values({
    partyId: personId,
    fullName: `Person ${personId}`,
    nameNormalized: `person ${personId}`,
    updatedAt: now,
  });
  await db.insert(ownerships).values({
    id: `${orgId}-${lotId}-own`,
    ownerPartyId: orgId,
    lotId,
    startDay:
      opts.ownershipStartDay === undefined
        ? '2026-01-01'
        : opts.ownershipStartDay,
    endDay: null,
    createdAt: now,
    updatedAt: now,
  });
  const representationId = `${personId}-${orgId}-rep`;
  await db.insert(representations).values({
    id: representationId,
    organizationPartyId: orgId,
    representativePersonId: personId,
    scopeKind: opts.scopeKind ?? 'organization',
    startDay: opts.representationStartDay ?? '2026-01-01',
    endDay: null,
    createdAt: now,
    updatedAt: now,
  });
  if ((opts.scopeKind ?? 'organization') === 'lots')
    await db.insert(representationLots).values({
      representationId,
      lotId,
      createdAt: now,
    });
}

beforeEach(async () => {
  // `truncateAll` clears the Person subtype and `parties`, but deliberately
  // leaves Organization-side roster rows to whoever seeded them (its own
  // comment says so), and `organizations` holds a composite FK into `parties`
  // that makes the shared teardown fail while one survives. So the
  // Representation chain comes down here first, innermost outward.
  const db = getDb(env);
  await db.delete(representationLots);
  await db.delete(representations);
  await db.delete(organizations);
  await truncateAll();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
});

describe('every export is classified', () => {
  /**
   * The naming convention is the only thing that states a Lot Record read's
   * scoping shape, so it is asserted rather than trusted. A new export that
   * fits neither name fails here — converting "I forgot to scope this" into a
   * build failure rather than a reviewer obligation.
   */
  const AUTHORITY_SCOPED = [
    'fetchMemberLotViolations',
    'fetchMemberLotViolation',
  ];
  const ADMIN_ONLY = ['fetchAdminLotViolations', 'fetchAdminLotRecordEvents'];

  it('names every read either fetchMember* or fetchAdminLot*', () => {
    const exported = Object.entries(lotRecords)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual([...AUTHORITY_SCOPED, ...ADMIN_ONLY].sort());
  });

  it('gives every Lot Record type a member read', () => {
    // One member read per record type, so a type added without its scoped read
    // cannot ship. ADR 0025's dues ledger joins this list with its own.
    expect([...LOT_RECORD_TYPES]).toEqual(['lot_violations']);
    expect(AUTHORITY_SCOPED).toContain('fetchMemberLotViolations');
  });
});

describe('fetchMemberLotViolations', () => {
  it('returns only the rows of lots the caller holds', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');
    await seedViolation('v-b', 'lot-b');

    const rows = await lotRecords.fetchMemberLotViolations(
      env,
      'person-1',
      DAY,
    );
    expect(rows.map((r) => r.id)).toEqual(['v-a']);
  });

  it('shows co-owners of one lot the identical rows', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedLotAuthority('person-2', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const first = await lotRecords.fetchMemberLotViolations(
      env,
      'person-1',
      DAY,
    );
    const second = await lotRecords.fetchMemberLotViolations(
      env,
      'person-2',
      DAY,
    );
    expect(first).toEqual(second);
    expect(first.map((r) => r.id)).toEqual(['v-a']);
  });

  it('hides records from before the caller period', async () => {
    // The buyer's Ownership starts 2026-06-01; the seller's period produced
    // v-old, which is not theirs to read.
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedViolation('v-old', 'lot-a', { effectiveDay: '2026-03-15' });
    await seedViolation('v-own', 'lot-a', { effectiveDay: '2026-07-04' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'buyer', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-own']);
  });

  it('shows a record dated exactly on the first day of the period', async () => {
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedViolation('v-day-one', 'lot-a', { effectiveDay: '2026-06-01' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'buyer', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-day-one']);
  });

  it('shows everything when the ownership start day is unknown', async () => {
    // A NULL start_day is legacy history ADR 0022 permits: the start is
    // unknown rather than recent, so detail is visible from the beginning.
    await seedLotAuthority('legacy-owner', 'lot-a', { startDay: null });
    await seedViolation('v-ancient', 'lot-a', { effectiveDay: '2019-01-01' });

    const rows = await lotRecords.fetchMemberLotViolations(
      env,
      'legacy-owner',
      DAY,
    );
    expect(rows.map((r) => r.id)).toEqual(['v-ancient']);
  });

  it('returns nothing to a former owner', async () => {
    await seedLotAuthority('seller', 'lot-a', {
      startDay: '2020-01-01',
      endDay: '2026-06-01',
    });
    await seedViolation('v-theirs', 'lot-a', { effectiveDay: '2021-05-05' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'seller', DAY);
    expect(rows).toEqual([]);
  });

  it('returns nothing to an unlinked account', async () => {
    // personId is null under cutover_mode = legacy and for any account with no
    // Person Link: there is no Person to scope by, so nothing is readable.
    await seedViolation('v-a', 'lot-a');
    expect(await lotRecords.fetchMemberLotViolations(env, null, DAY)).toEqual(
      [],
    );
  });

  it('hides a voided record', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-live', 'lot-a');
    await seedViolation('v-void', 'lot-a', { status: 'voided' });

    const rows = await lotRecords.fetchMemberLotViolations(
      env,
      'person-1',
      DAY,
    );
    expect(rows.map((r) => r.id)).toEqual(['v-live']);
  });

  it('never carries the board-only note', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a', { internalNote: 'call counsel' });

    const [row] = await lotRecords.fetchMemberLotViolations(
      env,
      'person-1',
      DAY,
    );
    expect(JSON.stringify(row)).not.toContain('call counsel');
    expect(row).not.toHaveProperty('internalNote');
  });

  it("reads an organization's lot through an organization-wide representation", async () => {
    await seedOrganizationAuthority('rep-1', 'org-1', 'lot-a');
    await seedViolation('v-a', 'lot-a', { effectiveDay: '2026-05-01' });
    await seedViolation('v-b', 'lot-b');

    const rows = await lotRecords.fetchMemberLotViolations(env, 'rep-1', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-a']);
  });

  it('limits a lot-scoped representation to the lots it names', async () => {
    await seedOrganizationAuthority('rep-1', 'org-1', 'lot-a', {
      scopeKind: 'lots',
    });
    // The same organization owns lot-b, but this representation does not name
    // it, so its records stay out of reach.
    await getDb(env)
      .insert(ownerships)
      .values({
        id: 'org-1-lot-b-own',
        ownerPartyId: 'org-1',
        lotId: 'lot-b',
        startDay: '2026-01-01',
        endDay: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
    await seedViolation('v-a', 'lot-a', { effectiveDay: '2026-05-01' });
    await seedViolation('v-b', 'lot-b', { effectiveDay: '2026-05-01' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'rep-1', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-a']);
  });

  it("bounds a representative at their own start when the organization's is unknown", async () => {
    // ADR 0022 permits a NULL Ownership start_day as legacy history. In the
    // owner branch that means "visible from the beginning"; here it must NOT,
    // because the Representation's own start is a known bound and is the later
    // of the two. It must also not make the MAX go NULL, which would deny the
    // whole branch and hide a legacy-imported organization's records entirely.
    await seedOrganizationAuthority('rep-1', 'org-1', 'lot-a', {
      ownershipStartDay: null,
      representationStartDay: '2026-06-01',
    });
    await seedViolation('v-before', 'lot-a', { effectiveDay: '2019-01-01' });
    await seedViolation('v-after', 'lot-a', { effectiveDay: '2026-07-01' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'rep-1', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-after']);
  });

  it('shows a representative a record dated on their first day', async () => {
    // The boundary is inclusive in both branches; the owner branch has its own
    // day-one case above.
    await seedOrganizationAuthority('rep-1', 'org-1', 'lot-a', {
      representationStartDay: '2026-06-01',
    });
    await seedViolation('v-day-one', 'lot-a', { effectiveDay: '2026-06-01' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'rep-1', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-day-one']);
  });

  it("starts a representative's period at the later of the two start days", async () => {
    // The organization has owned the lot since January, but this person has
    // represented it only since June. Their period starts in June.
    await seedOrganizationAuthority('rep-1', 'org-1', 'lot-a', {
      ownershipStartDay: '2026-01-01',
      representationStartDay: '2026-06-01',
    });
    await seedViolation('v-before', 'lot-a', { effectiveDay: '2026-03-01' });
    await seedViolation('v-after', 'lot-a', { effectiveDay: '2026-07-01' });

    const rows = await lotRecords.fetchMemberLotViolations(env, 'rep-1', DAY);
    expect(rows.map((r) => r.id)).toEqual(['v-after']);
  });
});

describe('fetchMemberLotViolation', () => {
  it('answers null for another lot record, exactly as for a missing one', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-b', 'lot-b');

    expect(
      await lotRecords.fetchMemberLotViolation(env, 'person-1', DAY, 'v-b'),
    ).toBeNull();
    expect(
      await lotRecords.fetchMemberLotViolation(
        env,
        'person-1',
        DAY,
        'no-such-id',
      ),
    ).toBeNull();
  });

  it('answers null for a record before the caller period', async () => {
    await seedLotAuthority('buyer', 'lot-a', { startDay: '2026-06-01' });
    await seedViolation('v-old', 'lot-a', { effectiveDay: '2026-03-15' });

    expect(
      await lotRecords.fetchMemberLotViolation(env, 'buyer', DAY, 'v-old'),
    ).toBeNull();
  });

  it('returns the caller own record', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const row = await lotRecords.fetchMemberLotViolation(
      env,
      'person-1',
      DAY,
      'v-a',
    );
    expect(row?.id).toBe('v-a');
  });
});

describe('board reads', () => {
  it('returns every lot, status, and board-only note', async () => {
    await seedViolation('v-a', 'lot-a', { internalNote: 'call counsel' });
    await seedViolation('v-void', 'lot-b', { status: 'voided' });

    const rows = await lotRecords.fetchAdminLotViolations(env);
    expect(rows.map((r) => r.id).sort()).toEqual(['v-a', 'v-void']);
    expect(rows.find((r) => r.id === 'v-a')?.internalNote).toBe('call counsel');
    expect(rows.find((r) => r.id === 'v-void')?.status).toBe('voided');
  });

  it('narrows to one lot when asked', async () => {
    await seedViolation('v-a', 'lot-a');
    await seedViolation('v-b', 'lot-b');

    const rows = await lotRecords.fetchAdminLotViolations(env, 'lot-b');
    expect(rows.map((r) => r.id)).toEqual(['v-b']);
  });

  it('reads one record event log, oldest first', async () => {
    await seedViolation('v-a', 'lot-a');
    await getDb(env)
      .insert(lotRecordEvents)
      .values([
        {
          id: 'e-2',
          recordType: 'lot_violations',
          recordId: 'v-a',
          action: 'cured',
          actingAccountId: 'board-account',
          reasonCode: 'homeowner-corrected',
          recordedAt: new Date('2026-09-05T12:00:00Z'),
        },
        {
          id: 'e-1',
          recordType: 'lot_violations',
          recordId: 'v-a',
          action: 'created',
          actingAccountId: 'board-account',
          reasonCode: null,
          recordedAt: new Date('2026-09-01T12:00:00Z'),
        },
      ]);

    const events = await lotRecords.fetchAdminLotRecordEvents(
      env,
      'lot_violations',
      'v-a',
    );
    expect(events.map((e) => e.id)).toEqual(['e-1', 'e-2']);
    expect(events[0].action).toBe('created');
  });
});

describe('the two flags', () => {
  async function seedFlags(gates: {
    officialMode: boolean;
    lotRecordsEnabled: boolean;
  }) {
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({ ...DEFAULT_SITE_SETTINGS, ...gates }),
        updatedAt: new Date(),
      });
  }

  /** The gate as a mutation boundary sees it, not as a route preflight does. */
  async function enabledInDb(): Promise<boolean> {
    const row = await env.DATABASE.prepare(
      `SELECT ${LOT_RECORDS_ENABLED_SQL} AS enabled`,
    ).first<{ enabled: number }>();
    return row?.enabled === 1;
  }

  it('is off until BOTH flags are on', async () => {
    for (const gates of [
      { officialMode: false, lotRecordsEnabled: false },
      { officialMode: true, lotRecordsEnabled: false },
      { officialMode: false, lotRecordsEnabled: true },
    ]) {
      await getDb(env).delete(settings);
      await seedFlags(gates);
      expect(await lotRecordsAvailable(env)).toBe(false);
      expect(await enabledInDb()).toBe(false);
    }

    await getDb(env).delete(settings);
    await seedFlags({ officialMode: true, lotRecordsEnabled: true });
    expect(await lotRecordsAvailable(env)).toBe(true);
    expect(await enabledInDb()).toBe(true);
  });

  it('is off when no settings row exists at all', async () => {
    // getSiteSettings fails closed, and the SQL predicate's EXISTS finds
    // nothing: an unconfigured site hides the surface rather than exposing it.
    expect(await lotRecordsAvailable(env)).toBe(false);
    expect(await enabledInDb()).toBe(false);
  });

  it('reads a JSON string "true" as off, not as on', async () => {
    // json_type, not json_extract: SQLite has no boolean, so `json_extract`
    // would coerce the string "true" and the number 1 into something that
    // compares equal to a real gate. Only the stored TYPE decides.
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({
          ...DEFAULT_SITE_SETTINGS,
          officialMode: true,
          lotRecordsEnabled: 'true',
        }),
        updatedAt: new Date(),
      });
    expect(await enabledInDb()).toBe(false);
    expect(await lotRecordsAvailable(env)).toBe(false);
  });
});
