import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('u-hoa', 'homeowner', []),
}));

import { GET } from '../../src/pages/api/files/[id]';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { callerContext } from './caller-context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  await env.DOCS.put('documents/hoa2/hoa.txt', 'homeowner-bytes');
  await env.DOCS.put('documents/brd2/b.txt', 'board-bytes');
  await getDb(env)
    .insert(documents)
    .values([
      {
        id: 'doc-hoa2',
        title: 'H',
        category: 'Other',
        visibility: 'homeowner',
        r2Key: 'documents/hoa2/hoa.txt',
        filename: 'hoa.txt',
        sizeBytes: 15,
        contentType: 'text/plain',
        uploadedAt: now,
        updatedAt: now,
      },
      {
        id: 'doc-brd2',
        title: 'B',
        category: 'Other',
        visibility: 'board',
        r2Key: 'documents/brd2/b.txt',
        filename: 'b.txt',
        sizeBytes: 11,
        contentType: 'text/plain',
        uploadedAt: now,
        updatedAt: now,
      },
    ]);
});

function ctx(id: string) {
  return {
    params: { id },
    request: new Request(`http://localhost/api/files/${id}`),
  } as never;
}

describe('file serving — authenticated homeowner', () => {
  it('serves a homeowner-tier file to a homeowner (allow path)', async () => {
    const res = await GET(ctx('doc-hoa2'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('homeowner-bytes');
  });
  it('404s a board-tier file for a homeowner, never confirming it exists', async () => {
    const res = await GET(ctx('doc-brd2'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });
});
