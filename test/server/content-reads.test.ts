import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET as documentsGet } from '../../src/pages/api/content/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const db = getDb(env);
  const now = new Date();
  await db.insert(documents).values([
    {
      id: 'd-pub',
      title: 'P',
      category: 'Other',
      visibility: 'public',
      r2Key: 'k1',
      filename: 'a',
      sizeBytes: 1,
      contentType: 't',
      uploadedAt: now,
      updatedAt: now,
    },
    {
      id: 'd-hoa',
      title: 'H',
      category: 'Other',
      visibility: 'homeowner',
      r2Key: 'k2',
      filename: 'b',
      sizeBytes: 1,
      contentType: 't',
      uploadedAt: now,
      updatedAt: now,
    },
    {
      id: 'd-brd',
      title: 'B',
      category: 'Other',
      visibility: 'board',
      r2Key: 'k3',
      filename: 'c',
      sizeBytes: 1,
      contentType: 't',
      uploadedAt: now,
      updatedAt: now,
    },
  ]);
});

describe('documents read endpoint', () => {
  it('an anonymous caller sees only public documents', async () => {
    const res = await documentsGet({
      request: new Request('http://localhost/api/content/documents'),
    } as never);
    expect(res.status).toBe(200);
    const items = (await res.json()) as { id: string }[];
    expect(items.map((i) => i.id)).toEqual(['d-pub']);
  });
});
