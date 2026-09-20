import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { normalizeSiteSettings, SITE_GATE_KEYS } from '../../src/lib/types';
import { legacyAuthContext } from '../../src/server/authz/context';
import { PUT } from '../../src/pages/api/admin/site';

/**
 * #363: the whole-blob `PUT /api/admin/site` must not be able to change a
 * gate, in either direction, no matter what a stale Site Settings tab resends
 * for it.
 *
 * Every case below drives `SITE_GATE_KEYS` rather than naming the gates, so a
 * gate added later — ADR 0024's `lotRecordsEnabled` (#291), ADR 0025's
 * `onlinePaymentsEnabled` — is covered the moment it joins that list, which is
 * also the moment the route starts preserving it. Naming them individually is
 * how a new gate ships with no test at all.
 */

/** Every gate set to one value, for seeding or for a request body. */
const allGates = (value: boolean): Record<string, boolean> =>
  Object.fromEntries(SITE_GATE_KEYS.map((key) => [key, value]));

const board = legacyAuthContext('board-1', 'board', []);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).run(sql.raw('DELETE FROM settings'));
});

function put(body: unknown) {
  return PUT({
    request: new Request('http://localhost/api/admin/site', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { authContext: board },
  } as never) as Promise<Response>;
}

async function storedSite() {
  const [row] = await getDb(env)
    .select()
    .from(settings)
    .where(eq(settings.key, 'site'));
  return normalizeSiteSettings(JSON.parse(row.value));
}

describe('PUT /api/admin/site preserves the stored gates', () => {
  it('cannot turn a gate off with a stale body that still carries the old "on" value', async () => {
    // The board turned both gates on through the audited transition (out of
    // scope here — seeded directly for this test's baseline).
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({ ...allGates(true), welcomeBody: 'Old copy.' }),
        updatedAt: new Date(),
      });

    // A stale tab loaded before the flip and now saves an unrelated field,
    // resending the "off" values it read on load.
    const res = await put({ welcomeBody: 'New copy.', ...allGates(false) });
    expect(res.status).toBe(204);

    const stored = await storedSite();
    for (const key of SITE_GATE_KEYS) expect(stored[key]).toBe(true);
    expect(stored.welcomeBody).toBe('New copy.');
  });

  it('cannot turn a gate on with a body that carries "true" for it', async () => {
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify(allGates(false)),
        updatedAt: new Date(),
      });

    const res = await put({
      welcomeBody: 'Attempted takeover.',
      ...allGates(true),
    });
    expect(res.status).toBe(204);

    const stored = await storedSite();
    for (const key of SITE_GATE_KEYS) expect(stored[key]).toBe(false);
  });

  it('never turns a gate on through a first-ever save, even if the body asks for it', async () => {
    // No settings row exists yet at all.
    const res = await put({ welcomeBody: 'First save.', ...allGates(true) });
    expect(res.status).toBe(204);

    const stored = await storedSite();
    for (const key of SITE_GATE_KEYS) expect(stored[key]).toBe(false);
    expect(stored.welcomeBody).toBe('First save.');
  });

  it('keeps the JSON boolean representation exact, not the SQL 0/1 json_extract would produce', async () => {
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
        updatedAt: new Date(),
      });

    await put({ welcomeBody: 'Copy edit.' });

    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'site'));
    // A literal JSON boolean, not the number 1 a naive json_extract copy
    // would have produced — this is exactly what `LIVE_VOTING_ENABLED_SQL`'s
    // `json_type(value, '$.liveVotingEnabled') = 'true'` depends on.
    expect(row.value).toContain('"officialMode":true');
    expect(row.value).toContain('"liveVotingEnabled":true');
  });
});
