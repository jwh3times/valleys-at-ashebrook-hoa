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
} from '../../src/pages/api/admin/board-people';
import {
  POST as termPost,
  PATCH as termPatch,
  DELETE as termDelete,
} from '../../src/pages/api/admin/board-terms';
import { getDb } from '../../src/server/db/client';
import { boardPeople, boardTerms } from '../../src/server/db/schema';
import type { BoardPersonWithTerms } from '../../src/lib/types';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(boardTerms);
  await db.delete(boardPeople);
});

const url = 'http://localhost/api/admin/board-people';
const termUrl = 'http://localhost/api/admin/board-terms';

function req(u: string, method: string, body?: unknown) {
  return {
    request: new Request(u, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

async function createPerson(fullName: string): Promise<string> {
  const res = await POST(req(url, 'POST', { fullName }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('board roster — board', () => {
  it('creates a person and returns them with an empty term list', async () => {
    await createPerson('A. Reyes');
    const list = (await (
      await GET(req(url, 'GET'))
    ).json()) as BoardPersonWithTerms[];
    expect(list.length).toBe(1);
    expect(list[0].fullName).toBe('A. Reyes');
    expect(list[0].terms).toEqual([]);
  });

  it('nests terms under their person, oldest first', async () => {
    const id = await createPerson('A. Reyes');
    // Insert the later term first so termStart ordering has to do real work —
    // insertion order alone must not already match expected order.
    await termPost(
      req(termUrl, 'POST', { personId: id, termStart: '2027-01-01' }),
    );
    await termPost(
      req(termUrl, 'POST', {
        personId: id,
        title: 'Treasurer',
        termStart: '2024-01-01',
        termEnd: '2025-12-31',
      }),
    );
    const list = (await (
      await GET(req(url, 'GET'))
    ).json()) as BoardPersonWithTerms[];
    expect(list[0].terms.map((t) => t.termStart)).toEqual([
      '2024-01-01',
      '2027-01-01',
    ]);
    expect(list[0].terms[0].title).toBe('Treasurer');
    expect(list[0].terms[1].termEnd).toBeNull();
  });

  it('lists people alphabetically by full name', async () => {
    await createPerson('C. Nguyen');
    await createPerson('A. Reyes');
    await createPerson('B. Ortiz');
    const list = (await (
      await GET(req(url, 'GET'))
    ).json()) as BoardPersonWithTerms[];
    expect(list.map((p) => p.fullName)).toEqual([
      'A. Reyes',
      'B. Ortiz',
      'C. Nguyen',
    ]);
  });

  it('renames a person', async () => {
    const id = await createPerson('A. Reyes');
    const res = await PATCH(
      req(url, 'PATCH', { id, fullName: 'A. Reyes-Cruz' }),
    );
    expect(res.status).toBe(204);
    const list = (await (
      await GET(req(url, 'GET'))
    ).json()) as BoardPersonWithTerms[];
    expect(list[0].fullName).toBe('A. Reyes-Cruz');
  });

  it('refuses to delete a person who has served, with 409', async () => {
    const id = await createPerson('A. Reyes');
    await termPost(
      req(termUrl, 'POST', { personId: id, termStart: '2026-01-01' }),
    );
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/term of service/i);
    const rows = await getDb(env).select().from(boardPeople);
    expect(rows.length).toBe(1);
  });

  it('deletes a person who has no terms', async () => {
    const id = await createPerson('Typo Person');
    const res = await DELETE(req(url, 'DELETE', { id }));
    expect(res.status).toBe(204);
    expect((await getDb(env).select().from(boardPeople)).length).toBe(0);
  });

  it('rejects a term for a person who does not exist, with 404', async () => {
    const res = await termPost(
      req(termUrl, 'POST', { personId: 'nope', termStart: '2026-01-01' }),
    );
    expect(res.status).toBe(404);
  });

  it('rejects a patch that would end a term before it started', async () => {
    const id = await createPerson('A. Reyes');
    const created = await termPost(
      req(termUrl, 'POST', { personId: id, termStart: '2026-06-01' }),
    );
    const termId = ((await created.json()) as { id: string }).id;
    const res = await termPatch(
      req(termUrl, 'PATCH', { id: termId, termEnd: '2026-01-01' }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/termEnd must not be before termStart/);
  });

  it('reopens a closed term while moving its start past the old end', async () => {
    const id = await createPerson('A. Reyes');
    const created = await termPost(
      req(termUrl, 'POST', {
        personId: id,
        termStart: '2026-01-01',
        termEnd: '2026-12-31',
      }),
    );
    const termId = ((await created.json()) as { id: string }).id;
    // Under a `??` merge (rather than `!== undefined`), an explicit
    // termEnd: null would fall back to the stored '2026-12-31' and this
    // would wrongly 400 against the new, later termStart.
    const res = await termPatch(
      req(termUrl, 'PATCH', {
        id: termId,
        termStart: '2027-01-01',
        termEnd: null,
      }),
    );
    expect(res.status).toBe(204);
    const list = (await (
      await GET(req(url, 'GET'))
    ).json()) as BoardPersonWithTerms[];
    expect(list[0].terms[0].termStart).toBe('2027-01-01');
    expect(list[0].terms[0].termEnd).toBeNull();
  });

  it('rejects a patch to a term that does not exist, with 404', async () => {
    const res = await termPatch(
      req(termUrl, 'PATCH', { id: 'nope', termEnd: '2026-01-01' }),
    );
    expect(res.status).toBe(404);
  });

  it('closes an open term', async () => {
    const id = await createPerson('A. Reyes');
    const created = await termPost(
      req(termUrl, 'POST', { personId: id, termStart: '2026-01-01' }),
    );
    const termId = ((await created.json()) as { id: string }).id;
    const res = await termPatch(
      req(termUrl, 'PATCH', { id: termId, termEnd: '2026-12-31' }),
    );
    expect(res.status).toBe(204);
    const list = (await (
      await GET(req(url, 'GET'))
    ).json()) as BoardPersonWithTerms[];
    expect(list[0].terms[0].termEnd).toBe('2026-12-31');
  });

  it('deletes a term, then allows deleting the person', async () => {
    const id = await createPerson('A. Reyes');
    const created = await termPost(
      req(termUrl, 'POST', { personId: id, termStart: '2026-01-01' }),
    );
    const termId = ((await created.json()) as { id: string }).id;
    expect(
      (await termDelete(req(termUrl, 'DELETE', { id: termId }))).status,
    ).toBe(204);
    expect((await DELETE(req(url, 'DELETE', { id }))).status).toBe(204);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await POST({
      request: new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    } as never);
    expect(res.status).toBe(400);
  });
});
