import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * The flags are re-checked INSIDE every mutation, not only at the route's
 * front door (ADR 0024, #291).
 *
 * The route's preflight and the mutation's SQL read the same two flags, so no
 * ordinary request can tell them apart — which is exactly why the in-SQL check
 * would be easy to delete without a single test noticing. This suite forces
 * them apart: `getSiteSettings` is mocked to report both flags ON while the
 * stored settings row says they are OFF, which is the shape of the real race —
 * a board request that passed its preflight a round trip before someone turned
 * the feature off.
 *
 * What must happen then is `409` and no write at all. Not a partial write, and
 * not an event row describing a change that did not happen.
 */
vi.mock('../../src/server/content/settings', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/server/content/settings')>();
  const { DEFAULT_SITE_SETTINGS } = await import('../../src/lib/types');
  return {
    ...actual,
    getSiteSettings: async () => ({
      ...DEFAULT_SITE_SETTINGS,
      officialMode: true,
      lotRecordsEnabled: true,
    }),
  };
});

import { POST } from '../../src/pages/api/admin/lot-violations';
import { getDb } from '../../src/server/db/client';
import {
  lotViolations,
  lotRecordEvents,
  settings,
} from '../../src/server/db/schema';
import { callerContext } from './caller-context';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import { seedProperty, truncateAll } from './fixtures';

const board = callerContext('board-1', 'board', []);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function post(body: unknown) {
  return POST({
    request: new Request('http://localhost/api/admin/lot-violations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { authContext: board },
  } as never) as Promise<Response>;
}

/** Both flags OFF in the database, while the mocked preflight says ON. */
async function storeFlagsOff() {
  await getDb(env).delete(settings);
  await getDb(env)
    .insert(settings)
    .values({
      key: 'site',
      value: JSON.stringify({
        ...DEFAULT_SITE_SETTINGS,
        officialMode: false,
        lotRecordsEnabled: false,
      }),
      updatedAt: new Date(),
    });
}

beforeEach(async () => {
  await truncateAll();
  await seedProperty('lot-a');
});

describe('a mutation whose preflight passed after the flags went off', () => {
  it('refuses to create, and writes neither the record nor an event', async () => {
    await storeFlagsOff();

    const res = await post({
      action: 'create',
      lotId: 'lot-a',
      category: 'parking',
      effectiveDay: '2026-09-01',
      summary: 'Boat parked in the street',
    });

    expect(res.status).toBe(409);
    expect(await getDb(env).select().from(lotViolations)).toHaveLength(0);
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(0);
  });

  it('refuses a transition and an edit on a record that already exists', async () => {
    // Seed the record directly: the point is the SECOND request, made after
    // the flags went off, and it must not move a record that is already there.
    await getDb(env).insert(lotViolations).values({
      id: 'v-1',
      lotId: 'lot-a',
      category: 'parking',
      effectiveDay: '2026-09-01',
      summary: 'Boat parked in the street',
      internalNote: null,
      status: 'open',
      createdBy: 'board-1',
      createdAt: new Date(),
    });
    await storeFlagsOff();

    expect((await post({ action: 'cure', id: 'v-1' })).status).toBe(409);
    expect(
      (await post({ action: 'void', id: 'v-1', reason: 'duplicate' })).status,
    ).toBe(409);
    expect(
      (await post({ action: 'edit', id: 'v-1', summary: 'Rewritten' })).status,
    ).toBe(409);

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('open');
    expect(row.summary).toBe('Boat parked in the street');
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(0);
  });
});
