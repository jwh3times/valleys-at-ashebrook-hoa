import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import {
  GET,
  POST,
  PATCH,
  DELETE,
} from '../../src/pages/api/admin/resolutions';
import { getDb } from '../../src/server/db/client';
import { resolutions, meetings, motions } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  // Clear self-referencing supersedesId links first — the RESTRICT foreign
  // key otherwise blocks deleting a row that another row still points to.
  await db.update(resolutions).set({ supersedesId: null });
  await db.delete(resolutions);
  await db.delete(motions);
  await db.delete(meetings);
});

const url = 'http://localhost/api/admin/resolutions';

function req(u: string, method: string, body?: unknown) {
  return {
    request: new Request(u, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

async function createResolution(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await getDb(env)
    .insert(resolutions)
    .values({
      id,
      number: `R-${id.slice(0, 8)}`,
      title: 'Pool hours',
      bodyMd: 'The pool is open 9am to 9pm.',
      status: 'draft',
      visibility: 'board',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  return id;
}

async function createMotion(): Promise<string> {
  const meetingId = crypto.randomUUID();
  const now = new Date();
  await getDb(env).insert(meetings).values({
    id: meetingId,
    body: 'board',
    kind: 'regular',
    date: '2026-01-01',
    title: 'January meeting',
    status: 'draft',
    visibility: 'board',
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
  });
  const motionId = crypto.randomUUID();
  await getDb(env).insert(motions).values({
    id: motionId,
    meetingId,
    sequence: 1,
    text: 'Move to adopt the resolution',
    outcome: 'passed',
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
  });
  return motionId;
}

async function getResolution(id: string) {
  const rows = await getDb(env)
    .select()
    .from(resolutions)
    .where(eq(resolutions.id, id));
  return rows[0];
}

describe('resolutions admin route — board', () => {
  it('creates a draft', async () => {
    const res = await POST(
      req(url, 'POST', {
        number: 'R-2026-01',
        title: 'Pool hours',
        bodyMd: 'The pool is open 9am to 9pm.',
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await getResolution(id);
    expect(row.status).toBe('draft');
    expect(row.number).toBe('R-2026-01');
    expect(row.createdBy).toBe('b');
  });

  it('rejects a create carrying status, with 400', async () => {
    const res = await POST(
      req(url, 'POST', {
        number: 'R-2026-01',
        title: 'Pool hours',
        bodyMd: 'Body',
        status: 'in_force',
      }),
    );
    expect(res.status).toBe(400);
    const rows = await getDb(env)
      .select()
      .from(resolutions)
      .where(eq(resolutions.number, 'R-2026-01'));
    expect(rows.length).toBe(0);
  });

  it('duplicate number returns 409 on create', async () => {
    await createResolution({ number: 'R-2026-05' });
    const res = await POST(
      req(url, 'POST', {
        number: 'R-2026-05',
        title: 'Another',
        bodyMd: 'Body',
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already exists/i);
    const rows = await getDb(env)
      .select()
      .from(resolutions)
      .where(eq(resolutions.number, 'R-2026-05'));
    expect(rows.length).toBe(1);
  });

  it('duplicate number returns 409 on patch', async () => {
    await createResolution({ number: 'R-2026-05' });
    const id = await createResolution({ number: 'R-2026-06' });
    const res = await PATCH(req(url, 'PATCH', { id, number: 'R-2026-05' }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already exists/i);
    const row = await getResolution(id);
    expect(row.number).toBe('R-2026-06');
  });

  it('adopt moves draft to in_force and sets the effective date', async () => {
    const id = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'adopt',
        id,
        effectiveDate: '2026-02-01',
      }),
    );
    expect(res.status).toBe(204);
    const row = await getResolution(id);
    expect(row.status).toBe('in_force');
    expect(row.effectiveDate).toBe('2026-02-01');
  });

  it('adopt records the adopting motion when given', async () => {
    const id = await createResolution();
    const motionId = await createMotion();
    const res = await POST(
      req(url, 'POST', {
        action: 'adopt',
        id,
        motionId,
        effectiveDate: '2026-02-01',
      }),
    );
    expect(res.status).toBe(204);
    const row = await getResolution(id);
    expect(row.adoptedByMotionId).toBe(motionId);
  });

  it('adopt on an already-in-force resolution returns 409', async () => {
    const id = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const res = await POST(
      req(url, 'POST', {
        action: 'adopt',
        id,
        effectiveDate: '2026-02-01',
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/not a draft/i);
    const row = await getResolution(id);
    expect(row.effectiveDate).toBe('2026-01-01');
  });

  it('adopt with a malformed effectiveDate returns 400', async () => {
    const id = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'adopt',
        id,
        effectiveDate: 'not a date',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/effectiveDate must be YYYY-MM-DD/);
    const row = await getResolution(id);
    expect(row.status).toBe('draft');
    expect(row.effectiveDate).toBeNull();
  });

  it('adopt with a non-calendar effectiveDate returns 400', async () => {
    // 2026-02-31 matches the YYYY-MM-DD shape but isn't a real day — this
    // only fails against the calendar-round-trip check, not a bare regex,
    // which is the point of this test.
    const id = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'adopt',
        id,
        effectiveDate: '2026-02-31',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not a valid calendar date/);
    const row = await getResolution(id);
    expect(row.status).toBe('draft');
    expect(row.effectiveDate).toBeNull();
  });

  it('adopt with an unknown motionId returns 404', async () => {
    const id = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'adopt',
        id,
        motionId: 'nope',
        effectiveDate: '2026-02-01',
      }),
    );
    expect(res.status).toBe(404);
    const row = await getResolution(id);
    expect(row.status).toBe('draft');
  });

  it('supersede sets the new one in force and the old one superseded, atomically', async () => {
    const oldId = await createResolution({
      number: 'R-2026-01',
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution({ number: 'R-2026-02' });
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(204);
    const newRow = await getResolution(newId);
    const oldRow = await getResolution(oldId);
    expect(newRow.status).toBe('in_force');
    expect(newRow.supersedesId).toBe(oldId);
    expect(newRow.effectiveDate).toBe('2026-03-01');
    expect(oldRow.status).toBe('superseded');
  });

  it('supersede without effectiveDate returns 400', async () => {
    const oldId = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
      }),
    );
    expect(res.status).toBe(400);
    const newRow = await getResolution(newId);
    const oldRow = await getResolution(oldId);
    expect(newRow.status).toBe('draft');
    expect(newRow.supersedesId).toBeNull();
    expect(oldRow.status).toBe('in_force');
  });

  it('supersede with a malformed effectiveDate returns 400', async () => {
    const oldId = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: 'not a date',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/effectiveDate must be YYYY-MM-DD/);
    const newRow = await getResolution(newId);
    const oldRow = await getResolution(oldId);
    expect(newRow.status).toBe('draft');
    expect(newRow.supersedesId).toBeNull();
    expect(oldRow.status).toBe('in_force');
  });

  it('supersede with a non-calendar effectiveDate returns 400', async () => {
    // 2026-02-31 matches the YYYY-MM-DD shape but isn't a real day — this
    // only fails against the calendar-round-trip check, not a bare regex,
    // which is the point of this test.
    const oldId = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-02-31',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not a valid calendar date/);
    const newRow = await getResolution(newId);
    const oldRow = await getResolution(oldId);
    expect(newRow.status).toBe('draft');
    expect(newRow.supersedesId).toBeNull();
    expect(oldRow.status).toBe('in_force');
  });

  it('supersede records the adopting motion when given', async () => {
    const oldId = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution();
    const motionId = await createMotion();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-03-01',
        motionId,
      }),
    );
    expect(res.status).toBe(204);
    const newRow = await getResolution(newId);
    expect(newRow.adoptedByMotionId).toBe(motionId);
  });

  it('supersede with an unknown motionId returns 404', async () => {
    const oldId = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-03-01',
        motionId: 'nope',
      }),
    );
    expect(res.status).toBe(404);
    const newRow = await getResolution(newId);
    const oldRow = await getResolution(oldId);
    expect(newRow.status).toBe('draft');
    expect(newRow.supersedesId).toBeNull();
    expect(oldRow.status).toBe('in_force');
  });

  it('supersede refuses self-supersession with 409', async () => {
    const id = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id,
        supersedesId: id,
        effectiveDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(409);
    // Self-supersession with an in-force row would also be a 409 from the
    // "must itself be draft" precondition, which would mask a missing
    // self-check — pin the message so this test actually exercises the
    // dedicated self-supersession guard, not a coincidental overlap.
    expect(await res.text()).toMatch(/itself/i);
    const row = await getResolution(id);
    expect(row.status).toBe('in_force');
    expect(row.supersedesId).toBeNull();
  });

  it('supersede refuses a predecessor that is not in force, with 409', async () => {
    const oldId = await createResolution({ status: 'draft' });
    const newId = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/not in force/i);
    const oldRow = await getResolution(oldId);
    const newRow = await getResolution(newId);
    expect(oldRow.status).toBe('draft');
    expect(newRow.status).toBe('draft');
  });

  it('supersede with a non-draft superseding resolution returns 409', async () => {
    const oldId = await createResolution({
      number: 'R-2026-01',
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution({
      number: 'R-2026-02',
      status: 'in_force',
      effectiveDate: '2026-01-15',
    });
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/must be a draft/i);
    const oldRow = await getResolution(oldId);
    const newRow = await getResolution(newId);
    expect(oldRow.status).toBe('in_force');
    expect(newRow.supersedesId).toBeNull();
  });

  it('supersede refuses a predecessor already superseded, with 409', async () => {
    const oldId = await createResolution({
      number: 'R-2026-01',
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    // Reach this precondition the only way it is actually reachable: insert
    // a second row directly that already claims to supersede oldId, without
    // going through the supersede action itself. Going through the action
    // (as an earlier version of this test did) also flips oldId's status
    // away from in_force, so the request would land on the earlier
    // not-in-force check instead and never exercise this one.
    await createResolution({
      number: 'R-2026-02',
      supersedesId: oldId,
    });
    const newId = await createResolution({ number: 'R-2026-03' });
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already superseded/i);
    const oldRow = await getResolution(oldId);
    const newRow = await getResolution(newId);
    expect(oldRow.status).toBe('in_force');
    expect(newRow.status).toBe('draft');
    expect(newRow.supersedesId).toBeNull();
  });

  it('supersede on a missing row returns 404', async () => {
    const newId = await createResolution();
    const res = await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: 'nope',
        effectiveDate: '2026-03-01',
      }),
    );
    expect(res.status).toBe(404);
    const newRow = await getResolution(newId);
    expect(newRow.status).toBe('draft');
    expect(newRow.supersedesId).toBeNull();
  });

  it('repeal moves in_force to repealed and leaves supersedesId links untouched', async () => {
    const oldId = await createResolution({
      number: 'R-2026-01',
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const newId = await createResolution({ number: 'R-2026-02' });
    await POST(
      req(url, 'POST', {
        action: 'supersede',
        id: newId,
        supersedesId: oldId,
        effectiveDate: '2026-02-01',
      }),
    );
    const res = await POST(req(url, 'POST', { action: 'repeal', id: newId }));
    expect(res.status).toBe(204);
    const newRow = await getResolution(newId);
    const oldRow = await getResolution(oldId);
    expect(newRow.status).toBe('repealed');
    expect(newRow.supersedesId).toBe(oldId);
    expect(oldRow.status).toBe('superseded');
  });

  it('repeal on a draft returns 409', async () => {
    const id = await createResolution();
    const res = await POST(req(url, 'POST', { action: 'repeal', id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/not in force/i);
    const row = await getResolution(id);
    expect(row.status).toBe('draft');
  });

  it('PATCH cannot write status, supersedesId, or adoptedByMotionId', async () => {
    const id = await createResolution();
    const res = await PATCH(
      req(url, 'PATCH', {
        id,
        status: 'in_force',
        supersedesId: 'x',
        adoptedByMotionId: 'y',
      }),
    );
    expect(res.status).toBe(400);
    const row = await getResolution(id);
    expect(row.status).toBe('draft');
    expect(row.supersedesId).toBeNull();
    expect(row.adoptedByMotionId).toBeNull();
  });

  it('PATCH updates title, bodyMd, and visibility', async () => {
    const id = await createResolution();
    const res = await PATCH(
      req(url, 'PATCH', {
        id,
        title: 'Updated pool hours',
        bodyMd: 'The pool is open 8am to 10pm.',
        visibility: 'public',
      }),
    );
    expect(res.status).toBe(204);
    const row = await getResolution(id);
    expect(row.title).toBe('Updated pool hours');
    expect(row.bodyMd).toBe('The pool is open 8am to 10pm.');
    expect(row.visibility).toBe('public');
  });

  it('PATCH refuses to clear effectiveDate on a non-draft resolution, with 409', async () => {
    const id = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const res = await PATCH(req(url, 'PATCH', { id, effectiveDate: null }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/cannot be cleared/i);
    const row = await getResolution(id);
    expect(row.effectiveDate).toBe('2026-01-01');
  });

  it('PATCH may clear effectiveDate on a draft resolution', async () => {
    const id = await createResolution({ effectiveDate: '2026-01-01' });
    const res = await PATCH(req(url, 'PATCH', { id, effectiveDate: null }));
    expect(res.status).toBe(204);
    const row = await getResolution(id);
    expect(row.effectiveDate).toBeNull();
  });

  it('PATCH on a nonexistent resolution returns 404', async () => {
    const res = await PATCH(req(url, 'PATCH', { id: 'nope', title: 'X' }));
    expect(res.status).toBe(404);
  });

  it('DELETE refuses a non-draft resolution with 409, and it survives', async () => {
    const id = await createResolution({
      status: 'in_force',
      effectiveDate: '2026-01-01',
    });
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/taken effect/i);
    const row = await getResolution(id);
    expect(row).toBeDefined();
  });

  it('DELETE refuses a draft that something supersedes, with 409', async () => {
    const oldId = await createResolution({ number: 'R-2026-01' });
    await createResolution({
      number: 'R-2026-02',
      supersedesId: oldId,
    });
    const res = await DELETE(req(url, 'DELETE', { id: oldId }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/superseded by another/i);
    const row = await getResolution(oldId);
    expect(row).toBeDefined();
  });

  it('DELETE removes an unreferenced draft', async () => {
    const id = await createResolution();
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    const row = await getResolution(id);
    expect(row).toBeUndefined();
  });

  it('GET returns resolutions via fetchAdminResolutions', async () => {
    await createResolution({ number: 'R-2026-09' });
    const res = await GET(req(url, 'GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { number: string }[];
    expect(rows.some((r) => r.number === 'R-2026-09')).toBe(true);
  });
});
