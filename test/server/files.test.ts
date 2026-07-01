import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/files/[id]';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const db = getDb(env);
  const now = new Date();
  await env.DOCS.put('documents/pub/pub.txt', 'public-bytes');
  await env.DOCS.put('documents/hoa/hoa.txt', 'homeowner-bytes');
  await db.insert(documents).values([
    {
      id: 'doc-pub',
      title: 'P',
      category: 'Other',
      visibility: 'public',
      r2Key: 'documents/pub/pub.txt',
      filename: 'pub.txt',
      sizeBytes: 12,
      contentType: 'text/plain',
      uploadedAt: now,
      updatedAt: now,
    },
    {
      id: 'doc-hoa',
      title: 'H',
      category: 'Other',
      visibility: 'homeowner',
      r2Key: 'documents/hoa/hoa.txt',
      filename: 'hoa.txt',
      sizeBytes: 15,
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

describe('file serving', () => {
  it('404s an unknown id', async () => {
    expect((await GET(ctx('nope'))).status).toBe(404);
  });
  it('serves a public file to an anonymous caller', async () => {
    const res = await GET(ctx('doc-pub'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('public-bytes');
  });
  it('403s a homeowner-tier file for an anonymous caller', async () => {
    expect((await GET(ctx('doc-hoa'))).status).toBe(403);
  });
});
