import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { PUT as putSite } from '../../src/pages/api/admin/site';
import { PUT as putDues } from '../../src/pages/api/admin/dues';
import { PATCH as patchDocument } from '../../src/pages/api/admin/documents';
import { legacyAuthContext } from '../../src/server/authz/context';

/**
 * Small contract failures on board-only routes, each of which answered with
 * something other than what the caller could act on: a 500 where every sibling
 * route returns 400, and a 204 that claimed an edit landed on a document that
 * does not exist.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function malformed(path: string, method: string) {
  return {
    request: new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    }),
  } as never;
}

describe('malformed JSON answers 400, not 500', () => {
  it('on PUT /api/admin/site', async () => {
    const res = await putSite(malformed('/api/admin/site', 'PUT'));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Malformed JSON body');
  });

  it('on PUT /api/admin/dues', async () => {
    const res = await putDues(malformed('/api/admin/dues', 'PUT'));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Malformed JSON body');
  });
});

describe('PATCH /api/admin/documents', () => {
  it('answers 404 for an unknown id rather than a silent 204', async () => {
    const res = await patchDocument({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'no-such-document', title: 'Renamed' }),
      }),
    } as never);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Document not found');
  });
});
