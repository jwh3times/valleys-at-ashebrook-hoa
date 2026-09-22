import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { GET, PUT } from '../../src/pages/api/admin/dues';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { legacyAuthContext } from '../../src/server/authz/context';

/**
 * The board's read of the dues blob (#364).
 *
 * This read used to be `GET /api/content/dues`, ungated, although the board's
 * Dues panel was its only caller — `/dues` reads `getDuesSettings` in its own
 * frontmatter. It now sits beside the PUT it mirrors, so the pair is
 * symmetric, and the normalization it has always done is asserted here
 * against the guarded route.
 */

const board = legacyAuthContext('board-1', 'board', []);
const homeowner = legacyAuthContext('owner-1', 'homeowner', ['lot-a']);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// The Workers pool isolates storage per FILE, not per test, so a `settings`
// row outlives the test that wrote it. Reset the two keys these tests touch,
// the way `permission-matrix.test.ts` does, rather than depending on the order
// they happen to run in.
beforeEach(async () => {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  // The freeze is a `cutover_settings` row, NOT a `settings` one — writing the
  // key to `settings` turns nothing on, which is how the assertion below would
  // have passed while the freeze never engaged.
  await db.delete(cutoverSettings);
});

function get(ctx: ReturnType<typeof legacyAuthContext> | null = board) {
  return GET({
    request: new Request('http://localhost/api/admin/dues'),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

describe('GET /api/admin/dues', () => {
  it('strips unknown keys and non-http(s) payment urls from a mangled stored blob', async () => {
    const now = new Date();
    const mangled = JSON.stringify({
      amount: '$250',
      dueDate: 'Jan 31',
      notes: 'late fee $25',
      evil: '<script>',
      paymentOptions: [
        { label: 'X', details: 'y', url: 'javascript:alert(1)' },
      ],
    });
    await getDb(env)
      .insert(settings)
      .values({
        key: 'dues',
        value: mangled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        // The same blob as `values` above, mirroring the PUT handler. A
        // different one here would make the assertions below pass for the
        // wrong reason on any run where the update fired.
        set: { value: mangled, updatedAt: now },
      });

    const res = await get();
    const body = (await res.json()) as {
      amount: string;
      paymentOptions: { url?: string }[];
      evil?: unknown;
    };
    expect(res.status).toBe(200);
    expect(body.amount).toBe('$250');
    expect('evil' in body).toBe(false);
    expect(body.paymentOptions[0].url).toBeUndefined();
  });

  it('refuses an anonymous caller', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('refuses a homeowner', async () => {
    expect((await get(homeowner)).status).toBe(403);
  });

  it('serves the board with official mode off, so dues can be prepared before adoption', async () => {
    const now = new Date();
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({ officialMode: false }),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: JSON.stringify({ officialMode: false }),
          updatedAt: now,
        },
      });

    expect((await get()).status).toBe(200);
  });

  it('stays live during a write freeze, because a freeze stops writes not reads', async () => {
    await getDb(env)
      .insert(cutoverSettings)
      .values({ key: 'write_freeze', value: 'on', updatedAt: new Date() });

    // The PUT's 503 is what proves the freeze is actually ON. Without it a
    // passing GET would be indistinguishable from a freeze that never
    // engaged, which is the way this assertion would rot.
    const frozen = await PUT({
      request: new Request('http://localhost/api/admin/dues', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '$1' }),
      }),
      locals: { authContext: board },
    } as never);
    expect(frozen.status).toBe(503);

    expect((await get()).status).toBe(200);
  });
});
