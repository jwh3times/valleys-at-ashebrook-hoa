import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/lot-violations';
import { getDb } from '../../src/server/db/client';
import {
  lotViolations,
  lotRecordEvents,
  settings,
} from '../../src/server/db/schema';
import { legacyAuthContext } from '../../src/server/authz/context';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import { seedProperty, truncateAll } from './fixtures';

/**
 * Board data entry for Lot Records (ADR 0024, #291 slice 2).
 *
 * Three things this suite is really about, beyond the CRUD:
 *
 * 1. **Board-first gate order.** `requireBoard` answers before the flags do,
 *    so an anonymous caller gets `401` and a signed-in non-board caller `403`
 *    even with the feature dark — matching the `/api/admin/*` middleware
 *    backstop and keeping `admin-routes-all-gated.test.ts` valid unchanged.
 *    Only a board caller learns whether the surface exists, and then it is
 *    `404`.
 * 2. **Every mutation leaves exactly one event**, in the same D1 batch, or
 *    leaves nothing at all.
 * 3. **Status moves only through the named actions**, and a voided record is
 *    terminal — nothing is hard-deleted, and nothing resurrects.
 */

const board = legacyAuthContext('board-1', 'board', []);
const homeowner = legacyAuthContext('owner-1', 'homeowner', ['lot-a']);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function post(
  body: unknown,
  ctx: ReturnType<typeof legacyAuthContext> | null = board,
) {
  return POST({
    request: new Request('http://localhost/api/admin/lot-violations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

function get(
  query = '',
  ctx: ReturnType<typeof legacyAuthContext> | null = board,
) {
  const url = `http://localhost/api/admin/lot-violations${query}`;
  return GET({
    request: new Request(url),
    locals: { authContext: ctx },
    url: new URL(url),
  } as never) as Promise<Response>;
}

async function setFlags(officialMode: boolean, lotRecordsEnabled: boolean) {
  await getDb(env).delete(settings);
  await getDb(env)
    .insert(settings)
    .values({
      key: 'site',
      value: JSON.stringify({
        ...DEFAULT_SITE_SETTINGS,
        officialMode,
        lotRecordsEnabled,
      }),
      updatedAt: new Date(),
    });
}

/** Create one violation through the route and hand back its id. */
async function createViolation(overrides: Record<string, unknown> = {}) {
  const res = await post({
    action: 'create',
    lotId: 'lot-a',
    category: 'parking',
    effectiveDay: '2026-09-01',
    summary: 'Boat parked in the street',
    ...overrides,
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return id;
}

beforeEach(async () => {
  await truncateAll();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
  await setFlags(true, true);
});

describe('gate order', () => {
  it('answers 401 to an anonymous caller even with the feature dark', async () => {
    await setFlags(false, false);
    expect((await post({ action: 'create' }, null)).status).toBe(401);
    expect((await get('', null)).status).toBe(401);
  });

  it('answers 403 to a signed-in non-board caller even with the feature dark', async () => {
    await setFlags(false, false);
    expect((await post({ action: 'create' }, homeowner)).status).toBe(403);
    expect((await get('', homeowner)).status).toBe(403);
  });

  it('answers 404 to the board when either flag is off', async () => {
    for (const [official, records] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      await setFlags(official, records);
      expect((await get()).status).toBe(404);
      expect((await post({ action: 'create' })).status).toBe(404);
    }
  });

  it('answers 400 to a malformed JSON body rather than 500', async () => {
    const res = (await POST({
      request: new Request('http://localhost/api/admin/lot-violations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
      locals: { authContext: board },
    } as never)) as Response;
    expect(res.status).toBe(400);
  });
});

describe('create', () => {
  it('records the violation and exactly one created event', async () => {
    const id = await createViolation();

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.id).toBe(id);
    expect(row.lotId).toBe('lot-a');
    expect(row.status).toBe('open');
    expect(row.createdBy).toBe('board-1');

    const events = await getDb(env).select().from(lotRecordEvents);
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('lot_violations');
    expect(events[0].recordId).toBe(id);
    expect(events[0].action).toBe('created');
  });

  it('refuses an unknown lot without writing anything', async () => {
    const res = await post({
      action: 'create',
      lotId: 'no-such-lot',
      category: 'parking',
      effectiveDay: '2026-09-01',
      summary: 'x',
    });
    expect(res.status).toBe(409);
    expect(await getDb(env).select().from(lotViolations)).toHaveLength(0);
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(0);
  });

  it('refuses a category outside the list', async () => {
    const res = await post({
      action: 'create',
      lotId: 'lot-a',
      category: 'vibes',
      effectiveDay: '2026-09-01',
      summary: 'x',
    });
    expect(res.status).toBe(400);
    expect(await getDb(env).select().from(lotViolations)).toHaveLength(0);
  });

  it('refuses a day that is not a real calendar date', async () => {
    for (const effectiveDay of ['2026-13-01', '2026-02-30', 'zzzz-99-99', '']) {
      const res = await post({
        action: 'create',
        lotId: 'lot-a',
        category: 'parking',
        effectiveDay,
        summary: 'x',
      });
      expect(res.status).toBe(400);
    }
    expect(await getDb(env).select().from(lotViolations)).toHaveLength(0);
  });

  it('refuses a blank summary', async () => {
    const res = await post({
      action: 'create',
      lotId: 'lot-a',
      category: 'parking',
      effectiveDay: '2026-09-01',
      summary: '   ',
    });
    expect(res.status).toBe(400);
  });
});

describe('transitions', () => {
  it('moves open to cured, then cured to closed, logging each', async () => {
    const id = await createViolation();

    expect((await post({ action: 'cure', id })).status).toBe(204);
    expect((await post({ action: 'close', id })).status).toBe(204);

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('closed');

    const events = await getDb(env).select().from(lotRecordEvents);
    expect(events.map((e) => e.action).sort()).toEqual([
      'closed',
      'created',
      'cured',
    ]);
  });

  it('refuses a move the record is not in a state for, and logs nothing', async () => {
    const id = await createViolation();
    // `reopen` applies to cured or closed, never to an open record.
    const res = await post({ action: 'reopen', id });
    expect(res.status).toBe(409);

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('open');
    expect(await getDb(env).select().from(lotRecordEvents)).toHaveLength(1);
  });

  it('refuses a transition on an unknown id', async () => {
    expect((await post({ action: 'cure', id: 'nope' })).status).toBe(409);
  });

  it('reopens a closed record', async () => {
    const id = await createViolation();
    await post({ action: 'close', id });
    expect((await post({ action: 'reopen', id })).status).toBe(204);
    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('open');
  });
});

describe('void', () => {
  it('requires a reason code and records it', async () => {
    const id = await createViolation();

    expect((await post({ action: 'void', id })).status).toBe(400);
    expect((await post({ action: 'void', id, reason: 'because' })).status).toBe(
      400,
    );

    const res = await post({
      action: 'void',
      id,
      reason: 'entered_in_error',
    });
    expect(res.status).toBe(204);

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('voided');
    const events = await getDb(env).select().from(lotRecordEvents);
    const voided = events.find((e) => e.action === 'voided');
    expect(voided?.reasonCode).toBe('entered_in_error');
  });

  it('never deletes the row', async () => {
    const id = await createViolation();
    await post({ action: 'void', id, reason: 'duplicate' });
    expect(await getDb(env).select().from(lotViolations)).toHaveLength(1);
  });

  it('is terminal — a voided record cannot be reopened, cured, or edited', async () => {
    const id = await createViolation();
    await post({ action: 'void', id, reason: 'duplicate' });

    for (const body of [
      { action: 'reopen', id },
      { action: 'cure', id },
      { action: 'close', id },
      { action: 'edit', id, summary: 'Rewritten' },
      { action: 'void', id, reason: 'other' },
    ])
      expect((await post(body)).status).toBe(409);

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('voided');
    expect(row.summary).toBe('Boat parked in the street');
  });
});

describe('edit', () => {
  it('changes descriptive fields and logs one edited event', async () => {
    const id = await createViolation();

    const res = await post({
      action: 'edit',
      id,
      summary: 'Trailer parked in the street',
      category: 'other',
      internalNote: 'photo on file',
      reason: 'homeowner_corrected',
    });
    expect(res.status).toBe(204);

    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.summary).toBe('Trailer parked in the street');
    expect(row.category).toBe('other');
    expect(row.internalNote).toBe('photo on file');
    expect(row.status).toBe('open');

    const events = await getDb(env).select().from(lotRecordEvents);
    const edited = events.find((e) => e.action === 'edited');
    expect(edited?.reasonCode).toBe('homeowner_corrected');
  });

  it('clears the board-only note when sent an empty value', async () => {
    const id = await createViolation({ internalNote: 'call counsel' });
    expect((await post({ action: 'edit', id, internalNote: '' })).status).toBe(
      204,
    );
    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.internalNote).toBeNull();
  });

  it('cannot set status, which is transition-only', async () => {
    const id = await createViolation();
    // `status` is not a field `edit` reads, so a body carrying it has nothing
    // to update and is refused rather than silently ignored.
    const res = await post({ action: 'edit', id, status: 'closed' });
    expect(res.status).toBe(400);
    const [row] = await getDb(env).select().from(lotViolations);
    expect(row.status).toBe('open');
  });

  it('refuses a blank summary', async () => {
    const id = await createViolation();
    expect((await post({ action: 'edit', id, summary: '  ' })).status).toBe(
      400,
    );
  });
});

describe('board reads', () => {
  it('returns every lot, including voided rows and board-only notes', async () => {
    const a = await createViolation({ internalNote: 'call counsel' });
    await createViolation({ lotId: 'lot-b', summary: 'Bins left out' });
    await post({ action: 'void', id: a, reason: 'duplicate' });

    const rows = (await (await get()).json()) as {
      id: string;
      status: string;
      internalNote: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a)?.status).toBe('voided');
    expect(rows.find((r) => r.id === a)?.internalNote).toBe('call counsel');
  });

  it('narrows to one lot', async () => {
    await createViolation();
    await createViolation({ lotId: 'lot-b', summary: 'Bins left out' });

    const rows = (await (await get('?lotId=lot-b')).json()) as {
      lotId: string;
    }[];
    expect(rows.map((r) => r.lotId)).toEqual(['lot-b']);
  });

  it('returns one record event log, oldest first', async () => {
    const id = await createViolation();
    await post({ action: 'cure', id });

    const events = (await (await get(`?events=${id}`)).json()) as {
      action: string;
    }[];
    expect(events.map((e) => e.action)).toEqual(['created', 'cured']);
  });
});

describe('unknown actions', () => {
  it('refuses one with 400 and names the ones that exist', async () => {
    const res = await post({ action: 'delete', id: 'x' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('create');
  });
});
