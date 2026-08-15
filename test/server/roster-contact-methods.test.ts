import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  contactMethods,
} from '../../src/server/db/roster-schema';
import { POST } from '../../src/pages/api/admin/roster-contact-methods';

/**
 * #218's board-recorded Contact Methods: normalized values, the one-preferred
 * partial unique satisfied by clearing inside the batch, endings and voids
 * freeing the preference, and category-only ledger traces.
 */

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
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'roster_change_subjects',
  'roster_changes',
  'access_events',
  'audit_events',
  'contact_methods',
  'people',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      await db.run(
        sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
      );
    }
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw('DELETE FROM users'));
  const now = new Date();
  await db.insert(users).values({
    id: 'board-1',
    name: 'board-1',
    email: 'board-1@example.test',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(parties)
    .values({ id: 'per-1', kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: 'per-1',
    partyKind: 'person',
    fullName: 'Contact Owner',
    nameNormalized: 'contact owner',
    updatedAt: now,
  });
});

function req(body: unknown): never {
  return {
    request: new Request('http://localhost/api/admin/roster-contact-methods', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as never;
}

describe('add', () => {
  it('normalizes the value and records the category, never the value', async () => {
    const res = await POST(
      req({
        action: 'add',
        partyId: 'per-1',
        channel: 'email',
        value: 'SECRET-ADDR@Example.COM',
        isPreferred: true,
      }),
    );
    expect(res.status).toBe(201);
    const db = getDb(env);
    const [row] = await db.select().from(contactMethods);
    expect(row.valueNormalized).toBe('secret-addr@example.com');
    expect(row.isPreferred).toBe(true);

    const hits = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM audit_scalar_changes WHERE old_text LIKE '%SECRET-ADDR%' OR new_text LIKE '%SECRET-ADDR%'`,
    );
    expect(hits[0].n).toBe(0);
    const sensitive = await db.all<{ field_category: string }>(
      sql`SELECT field_category FROM audit_sensitive_field_changes`,
    );
    expect(sensitive.map((s) => s.field_category)).toContain('email');
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('rejects an invalid value and an unknown party', async () => {
    const bad = await POST(
      req({
        action: 'add',
        partyId: 'per-1',
        channel: 'email',
        value: 'not-an-email',
      }),
    );
    expect(bad.status).toBe(400);
    const missing = await POST(
      req({
        action: 'add',
        partyId: 'nobody',
        channel: 'email',
        value: 'a@b.test',
      }),
    );
    expect(missing.status).toBe(404);
  });

  it('a second preferred method displaces the first inside one batch', async () => {
    const first = await POST(
      req({
        action: 'add',
        partyId: 'per-1',
        channel: 'email',
        value: 'a@b.test',
        isPreferred: true,
      }),
    );
    const firstId = ((await first.json()) as { id: string }).id;
    const second = await POST(
      req({
        action: 'add',
        partyId: 'per-1',
        channel: 'email',
        value: 'c@d.test',
        isPreferred: true,
      }),
    );
    expect(second.status).toBe(201);
    const db = getDb(env);
    const rows = await db.select().from(contactMethods);
    expect(rows.find((r) => r.id === firstId)?.isPreferred).toBe(false);
    expect(rows.filter((r) => r.isPreferred)).toHaveLength(1);
  });
});

describe('end, void, setPreferred', () => {
  async function add(value: string, isPreferred = false): Promise<string> {
    const res = await POST(
      req({
        action: 'add',
        partyId: 'per-1',
        channel: 'email',
        value,
        isPreferred,
      }),
    );
    return ((await res.json()) as { id: string }).id;
  }

  it('ends a method (freeing the preference) and refuses a re-end', async () => {
    const id = await add('a@b.test', true);
    const res = await POST(req({ action: 'end', contactMethodId: id }));
    expect(res.status).toBe(204);
    const db = getDb(env);
    const [row] = await db
      .select()
      .from(contactMethods)
      .where(eq(contactMethods.id, id));
    expect(row.endDay).not.toBeNull();
    expect(row.isPreferred).toBe(false);
    const again = await POST(req({ action: 'end', contactMethodId: id }));
    expect(again.status).toBe(409);
  });

  it('voids a method and refuses preference on a concluded one', async () => {
    const id = await add('a@b.test');
    const voided = await POST(req({ action: 'void', contactMethodId: id }));
    expect(voided.status).toBe(204);
    const preferConcluded = await POST(
      req({ action: 'setPreferred', contactMethodId: id }),
    );
    expect(preferConcluded.status).toBe(409);
  });

  it('setPreferred moves the preference and no-ops silently when already set', async () => {
    const a = await add('a@b.test', true);
    const b = await add('c@d.test');
    const res = await POST(req({ action: 'setPreferred', contactMethodId: b }));
    expect(res.status).toBe(204);
    const db = getDb(env);
    const rows = await db.select().from(contactMethods);
    expect(rows.find((r) => r.id === a)?.isPreferred).toBe(false);
    expect(rows.find((r) => r.id === b)?.isPreferred).toBe(true);

    const before = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM audit_events`,
    );
    const noop = await POST(
      req({ action: 'setPreferred', contactMethodId: b }),
    );
    expect(noop.status).toBe(204);
    const after = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM audit_events`,
    );
    expect(after[0].n).toBe(before[0].n);
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });
});
