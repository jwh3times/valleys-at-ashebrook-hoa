import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings, settingChanges } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { normalizeSiteSettings } from '../../src/lib/types';
import { legacyAuthContext } from '../../src/server/authz/context';
import { POST } from '../../src/pages/api/admin/site';

/**
 * #363's audited compare-and-swap: ADR 0024's mechanism, built here for the
 * two gates that already exist. One D1 batch: the CAS `UPDATE` and the
 * `setting_changes` insert either both land or neither does.
 */

const board = legacyAuthContext('board-1', 'board', []);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.run(sql.raw('DELETE FROM setting_changes'));
  await db.run(sql.raw('DELETE FROM settings'));
  await db.run(sql.raw('DELETE FROM cutover_settings'));
});

function post(body: unknown, ctx: ReturnType<typeof legacyAuthContext> | null) {
  return POST({
    request: new Request('http://localhost/api/admin/site', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

async function seedSite(gates: {
  officialMode: boolean;
  liveVotingEnabled: boolean;
}) {
  await getDb(env)
    .insert(settings)
    .values({
      key: 'site',
      value: JSON.stringify(gates),
      updatedAt: new Date(),
    });
}

async function storedGate(key: 'officialMode' | 'liveVotingEnabled') {
  const [row] = await getDb(env)
    .select()
    .from(settings)
    .where(eq(settings.key, 'site'));
  return normalizeSiteSettings(JSON.parse(row.value))[key];
}

async function changeRows() {
  return getDb(env).select().from(settingChanges);
}

describe('POST /api/admin/site { action: "setGate" }', () => {
  it('swaps the gate and writes exactly one audit row naming the actor', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });

    const res = await post(
      {
        action: 'setGate',
        key: 'liveVotingEnabled',
        expected: false,
        value: true,
      },
      board,
    );
    expect(res.status).toBe(204);
    expect(await storedGate('liveVotingEnabled')).toBe(true);

    const rows = await changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'liveVotingEnabled',
      oldValue: 'false',
      newValue: 'true',
      actingAccountId: 'board-1',
    });
    expect(rows[0].recordedAt).toBeInstanceOf(Date);
  });

  it('seeds a real default row and swaps against it on a brand-new site', async () => {
    // No settings row exists yet at all.
    const res = await post(
      { action: 'setGate', key: 'officialMode', expected: false, value: true },
      board,
    );
    expect(res.status).toBe(204);
    expect(await storedGate('officialMode')).toBe(true);
    expect(await changeRows()).toHaveLength(1);
  });

  it('refuses a stale expected value with 409 and writes nothing', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: true });

    const res = await post(
      // Caller's tab loaded when liveVotingEnabled was false; it has since
      // been turned on by someone else.
      {
        action: 'setGate',
        key: 'liveVotingEnabled',
        expected: false,
        value: false,
      },
      board,
    );
    expect(res.status).toBe(409);
    expect(await storedGate('liveVotingEnabled')).toBe(true);
    expect(await changeRows()).toHaveLength(0);
  });

  it('refuses a lost race against a concurrent flip with 409 and writes nothing extra', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });

    const first = await post(
      { action: 'setGate', key: 'officialMode', expected: false, value: true },
      board,
    );
    expect(first.status).toBe(204);

    // A second caller's tab still has the OLD "expected" from before the
    // first request won.
    const second = await post(
      { action: 'setGate', key: 'officialMode', expected: false, value: true },
      board,
    );
    expect(second.status).toBe(409);
    expect(await storedGate('officialMode')).toBe(true);
    expect(await changeRows()).toHaveLength(1);
  });

  it('refuses expected === value with 409 and writes nothing', async () => {
    await seedSite({ officialMode: true, liveVotingEnabled: false });

    const res = await post(
      { action: 'setGate', key: 'officialMode', expected: true, value: true },
      board,
    );
    expect(res.status).toBe(409);
    expect(await storedGate('officialMode')).toBe(true);
    expect(await changeRows()).toHaveLength(0);
  });

  it('refuses an unknown key with 400 and writes nothing', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });

    const res = await post(
      {
        action: 'setGate',
        key: 'lotRecordsEnabled',
        expected: false,
        value: true,
      },
      board,
    );
    expect(res.status).toBe(400);
    expect(await changeRows()).toHaveLength(0);
  });

  it('refuses non-boolean expected/value with 400', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });

    const res = await post(
      {
        action: 'setGate',
        key: 'officialMode',
        expected: 'false',
        value: true,
      },
      board,
    );
    expect(res.status).toBe(400);
    expect(await changeRows()).toHaveLength(0);
  });

  it('rejects an anonymous caller with 401 before touching the database', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });

    const res = await post(
      { action: 'setGate', key: 'officialMode', expected: false, value: true },
      null,
    );
    expect(res.status).toBe(401);
    expect(await storedGate('officialMode')).toBe(false);
    expect(await changeRows()).toHaveLength(0);
  });

  it('answers 503 under the write freeze and writes nothing', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });
    await getDb(env)
      .insert(cutoverSettings)
      .values({ key: 'write_freeze', value: 'on', updatedAt: new Date() });

    const res = await post(
      { action: 'setGate', key: 'officialMode', expected: false, value: true },
      board,
    );
    expect(res.status).toBe(503);
    expect(await storedGate('officialMode')).toBe(false);
    expect(await changeRows()).toHaveLength(0);
  });

  it('rejects an unknown action with 400', async () => {
    await seedSite({ officialMode: false, liveVotingEnabled: false });

    const res = await post({ action: 'flipTable' }, board);
    expect(res.status).toBe(400);
  });
});

describe('setGate against an incomplete stored blob', () => {
  it('treats a gate key absent from the stored row as off, so it can still be turned on', async () => {
    // A row written before this gate key existed — the shape every stored
    // row will have when ADR 0024/0025 add their flags to SITE_GATE_KEYS.
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({
          siteName: 'The Valleys at Ashebrook Residents',
        }),
        updatedAt: new Date(),
      });

    const res = await post(
      {
        action: 'setGate',
        key: 'liveVotingEnabled',
        expected: false,
        value: true,
      },
      board,
    );

    expect(res.status).toBe(204);
    expect(await storedGate('liveVotingEnabled')).toBe(true);
    expect(await changeRows()).toHaveLength(1);
  });

  it('still refuses a mismatched expectation against an incomplete row', async () => {
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({
          siteName: 'The Valleys at Ashebrook Residents',
        }),
        updatedAt: new Date(),
      });

    const res = await post(
      {
        action: 'setGate',
        key: 'liveVotingEnabled',
        expected: true,
        value: false,
      },
      board,
    );

    expect(res.status).toBe(409);
    expect(await changeRows()).toHaveLength(0);
  });
});

describe('setGate seeding on a brand-new site', () => {
  it('records no change and leaves the gates at their defaults when the expectation is stale', async () => {
    // No settings row exists. The batch seeds the defaults, then the CAS
    // loses against `expected: true`. The seeded row is what getSiteSettings
    // already falls back to, so this must be observably inert.
    const res = await post(
      {
        action: 'setGate',
        key: 'officialMode',
        expected: true,
        value: false,
      },
      board,
    );

    expect(res.status).toBe(409);
    expect(await changeRows()).toHaveLength(0);
    expect(await storedGate('officialMode')).toBe(false);
    expect(await storedGate('liveVotingEnabled')).toBe(false);
  });
});
