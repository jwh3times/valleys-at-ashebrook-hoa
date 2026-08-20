import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { owners, properties } from '../../src/server/db/schema';
import {
  parties,
  people,
  organizations,
  contactMethods,
} from '../../src/server/db/roster-schema';
import { loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';

/**
 * #233: the pseudonymizer's roster feed must read the PARTY roster, which has
 * been the live one since the ADR 0022 phase 3f flip, and not only the legacy
 * `owners`/`properties` tables that no roster route writes any more. A Person
 * recorded through the admin Roster panel that this feed cannot see is a
 * resident whose name reaches Anthropic unmasked.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const CLEAR = [
  'contact_methods',
  'organizations',
  'people',
  'parties',
  'owners',
  'properties',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    await db.run(sql.raw(`DELETE FROM ${table}`));
  }
});

const now = (): Date => new Date(1_700_000_000_000);

async function seedPerson(
  id: string,
  fullName: string | null,
  nameRedactedAt: Date | null = null,
): Promise<void> {
  const db = getDb(env);
  await db
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now(), updatedAt: now() });
  await db.insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName,
    nameNormalized: fullName ? fullName.toLowerCase() : null,
    nameRedactedAt,
    updatedAt: now(),
  });
}

async function seedContact(
  id: string,
  partyId: string,
  partyKind: 'person' | 'organization',
  channel: 'email' | 'sms',
  value: string | null,
  extra: { endDay?: string; voidedAt?: Date; redactedAt?: Date } = {},
): Promise<void> {
  await getDb(env)
    .insert(contactMethods)
    .values({
      id,
      partyId,
      partyKind,
      channel,
      value,
      valueNormalized: value ? value.toLowerCase() : null,
      endDay: extra.endDay ?? null,
      voidedAt: extra.voidedAt ?? null,
      redactedAt: extra.redactedAt ?? null,
      createdAt: now(),
      updatedAt: now(),
    });
}

function valuesOf(
  entries: Awaited<ReturnType<typeof loadRosterEntries>>,
  type: string,
): string[] {
  return entries.filter((e) => e.type === type).map((e) => e.value);
}

describe('loadRosterEntries reads the party roster', () => {
  it('includes a Person recorded only in the party roster', async () => {
    await seedPerson('p1', 'Dana Rivera');

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'name')).toContain('Dana Rivera');
  });

  it('masks a party-roster-only Person in an excerpt', async () => {
    await seedPerson('p1', 'Dana Rivera');

    const pseud = buildPseudonymizer(await loadRosterEntries(env));
    const masked = pseud.anonymize('Dana Rivera owes $50 for 2026 dues.');

    expect(masked).not.toContain('Dana Rivera');
    expect(masked).not.toContain('Dana');
    expect(masked).not.toContain('Rivera');
  });

  it('includes Contact Methods on both channels, mapped to the right PII type', async () => {
    await seedPerson('p1', 'Dana Rivera');
    await seedContact('c1', 'p1', 'person', 'email', 'dana@realmail.com');
    await seedContact('c2', 'p1', 'person', 'sms', '(919) 555-0142');

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'email')).toContain('dana@realmail.com');
    expect(valuesOf(entries, 'phone')).toContain('(919) 555-0142');
  });

  it('includes an ended or voided Contact Method — a stale value still appears in old documents', async () => {
    await seedPerson('p1', 'Dana Rivera');
    await seedContact('c1', 'p1', 'person', 'email', 'old@realmail.com', {
      endDay: '2020-01-01',
    });
    await seedContact('c2', 'p1', 'person', 'sms', '(919) 555-0143', {
      voidedAt: now(),
    });

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'email')).toContain('old@realmail.com');
    expect(valuesOf(entries, 'phone')).toContain('(919) 555-0143');
  });

  it("includes an organization's Contact Method, which is often a resident's own", async () => {
    const db = getDb(env);
    await db.insert(parties).values({
      id: 'g1',
      kind: 'organization',
      createdAt: now(),
      updatedAt: now(),
    });
    await db.insert(organizations).values({
      partyId: 'g1',
      partyKind: 'organization',
      legalName: 'Rivera Family Trust',
      nameNormalized: 'rivera family trust',
      updatedAt: now(),
    });
    await seedContact(
      'c1',
      'g1',
      'organization',
      'email',
      'trust@realmail.com',
    );

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'email')).toContain('trust@realmail.com');
  });

  it('skips a redacted Person name rather than resurrecting it', async () => {
    await seedPerson('p1', null, now());

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'name')).toHaveLength(0);
  });

  it('skips a redacted Contact Method value', async () => {
    await seedPerson('p1', 'Dana Rivera');
    await seedContact('c1', 'p1', 'person', 'email', null, {
      redactedAt: now(),
    });

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'email')).toHaveLength(0);
  });

  it('still reads the legacy roster, and does not double-register a backfilled Person', async () => {
    const db = getDb(env);
    await db.insert(properties).values({
      id: 'lot-1',
      address: '123 Ashebrook Lane',
      addressNormalized: '123 ashebrook lane',
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    });
    await db.insert(owners).values({
      id: 'o1',
      propertyId: 'lot-1',
      fullName: 'Dana Rivera',
      email: 'dana@realmail.com',
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    });
    // The same human, backfilled into the party roster by the flip.
    await seedPerson('p1', 'Dana Rivera');
    await seedContact('c1', 'p1', 'person', 'email', 'dana@realmail.com');

    const entries = await loadRosterEntries(env);

    expect(valuesOf(entries, 'address')).toEqual(['123 Ashebrook Lane']);
    expect(valuesOf(entries, 'name')).toEqual(['Dana Rivera']);
    expect(valuesOf(entries, 'email')).toEqual(['dana@realmail.com']);
  });

  it('excludes organization NAMES, whose tokens would rewrite the neighborhood itself', async () => {
    const db = getDb(env);
    await db.insert(parties).values({
      id: 'g1',
      kind: 'organization',
      createdAt: now(),
      updatedAt: now(),
    });
    await db.insert(organizations).values({
      partyId: 'g1',
      partyKind: 'organization',
      legalName: 'The Valleys at Ashebrook HOA',
      nameNormalized: 'the valleys at ashebrook hoa',
      updatedAt: now(),
    });

    const pseud = buildPseudonymizer(await loadRosterEntries(env));

    // Deliberate boundary, not an oversight: `name` entries are tokenized, so
    // registering this would turn "Ashebrook" into a surrogate person name in
    // every excerpt. Documented on loadRosterEntries and in #233.
    expect(valuesOf(await loadRosterEntries(env), 'name')).toHaveLength(0);
    expect(pseud.anonymize('The Valleys at Ashebrook HOA met.')).toContain(
      'Ashebrook',
    );
  });
});
