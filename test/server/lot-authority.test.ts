import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  organizations,
  ownerships,
  parties,
  people,
  representationLots,
  representations,
} from '../../src/server/db/roster-schema';
import {
  authorityKey,
  fetchLotAuthority,
  fetchLotAuthorityHistory,
  fetchPersonAuthority,
  hasEverHeldLotAuthority,
  lotAuthorityExists,
} from '../../src/server/roster/authority';
import { seedMeeting, seedProperty, seedProxy, truncateAll } from './fixtures';

/**
 * WHO MAY ACT FOR A LOT (#248 part 2).
 *
 * `roster/authority.ts` is the single definition the meeting, elections, and
 * proxies records now consult for who acted, having been repointed off
 * `owners` by migration 0029. It holds that rule TWICE — a Drizzle reader for
 * preflights and pickers, and a raw-SQL fragment for the mutation-boundary
 * predicates — so the last describe here runs both over the same fixtures and
 * compares. A divergence between them is the failure mode that would let a
 * cast pass its preflight and be silently refused by its own INSERT, or worse,
 * the reverse.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();
const TODAY = '2026-06-15';

beforeEach(async () => {
  const db = getDb(env);
  // Every subtype and scope row goes before truncateAll(), which clears
  // `parties` — the table all of them reference.
  await db.delete(representationLots);
  await db.delete(representations);
  await db.delete(organizations);
  await truncateAll();
});

async function seedPerson(id: string, fullName: string | null = `P ${id}`) {
  const db = getDb(env);
  await db
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName,
    nameNormalized: fullName?.toLowerCase() ?? null,
    nameRedactedAt: fullName === null ? now : null,
    updatedAt: now,
  });
}

async function seedOrganization(id: string, legalName = `Org ${id}`) {
  const db = getDb(env);
  await db
    .insert(parties)
    .values({ id, kind: 'organization', createdAt: now, updatedAt: now });
  await db.insert(organizations).values({
    partyId: id,
    partyKind: 'organization',
    legalName,
    nameNormalized: legalName.toLowerCase(),
    updatedAt: now,
  });
}

async function seedOwnership(
  id: string,
  ownerPartyId: string,
  lotId: string,
  overrides: {
    startDay?: string | null;
    endDay?: string | null;
    voidedAt?: Date | null;
  } = {},
) {
  await getDb(env)
    .insert(ownerships)
    .values({
      id,
      ownerPartyId,
      lotId,
      startDay: overrides.startDay ?? null,
      endDay: overrides.endDay ?? null,
      voidedAt: overrides.voidedAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedRepresentation(
  id: string,
  representativePersonId: string,
  organizationPartyId: string,
  overrides: {
    scopeKind?: 'organization' | 'lots';
    startDay?: string;
    endDay?: string | null;
    voidedAt?: Date | null;
    lots?: { lotId: string; voided?: boolean }[];
  } = {},
) {
  const db = getDb(env);
  await db.insert(representations).values({
    id,
    representativePersonId,
    organizationPartyId,
    scopeKind: overrides.scopeKind ?? 'organization',
    startDay: overrides.startDay ?? '2025-01-01',
    endDay: overrides.endDay ?? null,
    voidedAt: overrides.voidedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  for (const lot of overrides.lots ?? []) {
    await db.insert(representationLots).values({
      representationId: id,
      lotId: lot.lotId,
      voidedAt: lot.voided ? now : null,
      createdAt: now,
    });
  }
}

const idsFor = async (lotId: string) =>
  (await fetchLotAuthority(getDb(env), [lotId], TODAY)).map((r) => r.personId);

describe('Lot Authority through Ownership', () => {
  beforeEach(async () => {
    await seedProperty('lot-1');
  });

  it('names a Person who owns the lot today', async () => {
    await seedPerson('per-1', 'Jane Doe');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    expect(await fetchLotAuthority(getDb(env), ['lot-1'], TODAY)).toEqual([
      { personId: 'per-1', lotId: 'lot-1', fullName: 'Jane Doe' },
    ]);
  });

  it('treats a NULL start day as accepted legacy history, not as unstarted', async () => {
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1', { startDay: null });
    expect(await idsFor('lot-1')).toEqual(['per-1']);
  });

  it('excludes an Ownership that has not started and one that has ended', async () => {
    await seedPerson('per-future');
    await seedPerson('per-past');
    await seedOwnership('own-future', 'per-future', 'lot-1', {
      startDay: '2026-12-01',
    });
    await seedOwnership('own-past', 'per-past', 'lot-1', {
      startDay: '2020-01-01',
      endDay: '2024-01-01',
    });
    expect(await idsFor('lot-1')).toEqual([]);
  });

  it('ends authority ON the end day, not after it', async () => {
    // `day < end_day`: a lot sold today confers nothing today, which is what
    // makes ending an Ownership take effect immediately.
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1', { endDay: TODAY });
    expect(await idsFor('lot-1')).toEqual([]);
  });

  it('excludes a voided Ownership, which was recorded in error', async () => {
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1', { voidedAt: now });
    expect(await idsFor('lot-1')).toEqual([]);
    expect(await hasEverHeldLotAuthority(getDb(env), 'per-1', 'lot-1')).toBe(
      false,
    );
  });

  it('renders a redacted Person as the durable-ID fallback, not as blank', async () => {
    await seedPerson('per-redacted', null);
    await seedOwnership('own-1', 'per-redacted', 'lot-1');
    const [row] = await fetchLotAuthority(getDb(env), ['lot-1'], TODAY);
    expect(row.fullName).toBe('Resident per-reda');
  });
});

describe('Lot Authority through Representation', () => {
  beforeEach(async () => {
    await seedProperty('lot-1');
    await seedProperty('lot-2');
    await seedOrganization('org-1');
    await seedPerson('rep-1', 'Rep One');
  });

  it('names the Representative of an owning Organization, never the Organization', async () => {
    await seedOwnership('own-org', 'org-1', 'lot-1');
    await seedRepresentation('rep-row', 'rep-1', 'org-1');
    // The Organization holds the Ownership but is structurally absent: both
    // branches join `people`, so only its Representative can act.
    expect(await idsFor('lot-1')).toEqual(['rep-1']);
  });

  it('follows organization scope to whatever the entity owns, including a later purchase', async () => {
    await seedOwnership('own-org-1', 'org-1', 'lot-1');
    await seedRepresentation('rep-row', 'rep-1', 'org-1');
    expect(await idsFor('lot-2')).toEqual([]);

    await seedOwnership('own-org-2', 'org-1', 'lot-2');
    expect(await idsFor('lot-2')).toEqual(['rep-1']);
  });

  it('limits lots scope to its named lots, and to ones the entity still owns', async () => {
    await seedOwnership('own-org-1', 'org-1', 'lot-1');
    await seedOwnership('own-org-2', 'org-1', 'lot-2');
    await seedRepresentation('rep-row', 'rep-1', 'org-1', {
      scopeKind: 'lots',
      lots: [{ lotId: 'lot-1' }],
    });
    expect(await idsFor('lot-1')).toEqual(['rep-1']);
    expect(await idsFor('lot-2')).toEqual([]);
  });

  it('stops granting through a scope row that was voided on correction', async () => {
    await seedOwnership('own-org-1', 'org-1', 'lot-1');
    await seedRepresentation('rep-row', 'rep-1', 'org-1', {
      scopeKind: 'lots',
      lots: [{ lotId: 'lot-1', voided: true }],
    });
    expect(await idsFor('lot-1')).toEqual([]);
  });

  it('keeps a FUTURE end day as authority until it arrives (#202)', async () => {
    await seedOwnership('own-org', 'org-1', 'lot-1');
    await seedRepresentation('rep-row', 'rep-1', 'org-1', {
      endDay: '2026-12-31',
    });
    expect(await idsFor('lot-1')).toEqual(['rep-1']);
  });

  it('drops a Representation that has ended or been voided', async () => {
    await seedOwnership('own-org', 'org-1', 'lot-1');
    await seedRepresentation('rep-ended', 'rep-1', 'org-1', {
      endDay: '2025-06-01',
    });
    expect(await idsFor('lot-1')).toEqual([]);

    await seedPerson('rep-2');
    await seedRepresentation('rep-voided', 'rep-2', 'org-1', {
      voidedAt: now,
    });
    expect(await idsFor('lot-1')).toEqual([]);
  });
});

describe('the history and person-scoped reads', () => {
  it('flags a former holder as not current rather than hiding them', async () => {
    await seedProperty('lot-1');
    await seedPerson('per-now', 'Now Owner');
    await seedPerson('per-then', 'Then Owner');
    await seedOwnership('own-now', 'per-now', 'lot-1');
    await seedOwnership('own-then', 'per-then', 'lot-1', {
      endDay: '2024-01-01',
    });

    const history = await fetchLotAuthorityHistory(getDb(env), TODAY);
    expect(
      history
        .map((r) => [r.personId, r.current])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['per-now', true],
      ['per-then', false],
    ]);
    // The entry-time question a proxy grantor is asked answers yes for both.
    expect(await hasEverHeldLotAuthority(getDb(env), 'per-then', 'lot-1')).toBe(
      true,
    );
  });

  it('answers what one Person holds, across lots', async () => {
    await seedProperty('lot-1');
    await seedProperty('lot-2');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    await seedOwnership('own-2', 'per-1', 'lot-2');
    const rows = await fetchPersonAuthority(getDb(env), 'per-1', TODAY);
    expect(rows.map((r) => r.lotId).sort()).toEqual(['lot-1', 'lot-2']);
  });
});

describe('the two expressions of the rule agree', () => {
  /** The raw-SQL fragment's answer for one (person, lot) pair. */
  async function existsSaysYes(personId: string, lotId: string) {
    const guard = lotAuthorityExists(
      { value: personId },
      { value: lotId },
      TODAY,
    );
    const [row] = await env.DATABASE.prepare(`SELECT ${guard.sql} AS holds`)
      .bind(...(guard.binds as string[]))
      .all<{ holds: number }>()
      .then((r) => r.results);
    return row.holds === 1;
  }

  /**
   * Every case above that distinguishes authority from its absence, run
   * through BOTH expressions. The Drizzle reader answers preflights and
   * pickers; the fragment answers inside the casting INSERT. They are separate
   * code, deliberately (ADR 0020's two layers), so this is the only thing
   * standing between them and a silent divergence.
   */
  it('matches the Drizzle reader across ownership, interval, void, and representation cases', async () => {
    const db = getDb(env);
    await seedProperty('lot-1');
    await seedProperty('lot-2');
    await seedOrganization('org-1');
    await seedPerson('per-current');
    await seedPerson('per-ended');
    await seedPerson('per-voided');
    await seedPerson('per-future');
    await seedPerson('rep-org');
    await seedPerson('rep-scoped');
    await seedPerson('per-stranger');

    await seedOwnership('own-current', 'per-current', 'lot-1');
    await seedOwnership('own-ended', 'per-ended', 'lot-1', {
      endDay: '2025-01-01',
    });
    await seedOwnership('own-voided', 'per-voided', 'lot-1', {
      voidedAt: now,
    });
    await seedOwnership('own-future', 'per-future', 'lot-1', {
      startDay: '2026-12-01',
    });
    await seedOwnership('own-org', 'org-1', 'lot-2');
    await seedRepresentation('rep-row-org', 'rep-org', 'org-1');
    await seedRepresentation('rep-row-scoped', 'rep-scoped', 'org-1', {
      scopeKind: 'lots',
      lots: [{ lotId: 'lot-1' }],
    });

    const pairs: [string, string][] = [
      ['per-current', 'lot-1'],
      ['per-current', 'lot-2'],
      ['per-ended', 'lot-1'],
      ['per-voided', 'lot-1'],
      ['per-future', 'lot-1'],
      ['rep-org', 'lot-1'],
      ['rep-org', 'lot-2'],
      ['rep-scoped', 'lot-1'],
      ['rep-scoped', 'lot-2'],
      ['per-stranger', 'lot-1'],
    ];

    const reader = new Set(
      (
        await Promise.all(
          ['lot-1', 'lot-2'].map((lotId) =>
            fetchLotAuthority(db, [lotId], TODAY),
          ),
        )
      )
        .flat()
        .map((r) => authorityKey(r.personId, r.lotId)),
    );

    const disagreements: string[] = [];
    for (const [personId, lotId] of pairs) {
      const viaReader = reader.has(authorityKey(personId, lotId));
      const viaSql = await existsSaysYes(personId, lotId);
      if (viaReader !== viaSql)
        disagreements.push(
          `${personId}/${lotId}: reader ${viaReader}, SQL ${viaSql}`,
        );
    }
    expect(disagreements).toEqual([]);

    // Positive control: the pair set really does contain both answers, so an
    // agreement of "always false" could not pass this test.
    expect(reader.has(authorityKey('per-current', 'lot-1'))).toBe(true);
    expect(reader.has(authorityKey('per-stranger', 'lot-1'))).toBe(false);
  });

  it('binds a column operand without a parameter, for the casting predicates', async () => {
    // The casting SQL passes column references (a proxy's holder and grantor)
    // rather than values; only `day` binds in that shape.
    const guard = lotAuthorityExists(
      { column: 'px.grantor_person_id' },
      { column: 'px.property_id' },
      TODAY,
    );
    expect(guard.binds).toEqual(Array(6).fill(TODAY));

    await seedProperty('lot-1');
    await seedPerson('per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');
    // Exactly one occasion, or `proxies_one_occasion` refuses the row.
    await seedMeeting('mtg-1', { body: 'member' });
    await seedProxy('px-1', {
      propertyId: 'lot-1',
      grantorPersonId: 'per-1',
      meetingId: 'mtg-1',
    });

    const [row] = await env.DATABASE.prepare(
      `SELECT ${guard.sql} AS holds FROM proxies px WHERE px.id = 'px-1'`,
    )
      .bind(...(guard.binds as string[]))
      .all<{ holds: number }>()
      .then((r) => r.results);
    expect(row.holds).toBe(1);
  });
});
