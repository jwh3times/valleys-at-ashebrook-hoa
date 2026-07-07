import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { eq } from 'drizzle-orm';
import { GET, POST } from '../../src/pages/api/admin/duplicates';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function seed(
  id: string,
  content: string,
  filename: string,
  hash: string | null,
) {
  const key = `documents/${id}/${filename}`;
  await env.DOCS.put(key, content);
  const now = new Date();
  await getDb(env)
    .insert(documents)
    .values({
      id,
      title: filename.replace(/\.[^.]+$/, ''),
      category: 'Other',
      visibility: 'board',
      r2Key: key,
      filename,
      sizeBytes: content.length,
      contentType: 'application/pdf',
      contentHash: hash,
      uploadedAt: now,
      updatedAt: now,
    });
}

const call = (fn: typeof GET, method: string, body?: unknown) =>
  fn({
    request: new Request('http://localhost/api/admin/duplicates', {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  } as never);

describe('admin duplicates - board', () => {
  it('lazy-backfills hashes and reports an exact group', async () => {
    await seed('d1', 'identical-bytes', 'a.pdf', null);
    await seed('d2', 'identical-bytes', 'a(1).pdf', null);
    const res = await call(GET, 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exact: { members: { id: string }[]; suggestedKeepId: string }[];
      remaining: number;
    };
    const group = body.exact.find((g) => g.members.some((m) => m.id === 'd1'));
    expect(group).toBeTruthy();
    expect(group!.members.map((m) => m.id).sort()).toEqual(['d1', 'd2']);
    expect(group!.suggestedKeepId).toBe('d1');
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'd1'));
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a group by deleting the extras from D1 and R2', async () => {
    await seed('keep', 'keep-bytes', 'keep.pdf', 'kh');
    await seed('drop', 'drop-bytes', 'drop.pdf', 'dh');
    const res = await call(POST, 'POST', {
      action: 'resolve',
      keepId: 'keep',
      deleteIds: ['drop'],
    });
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'drop'));
    expect(rows.length).toBe(0);
    expect(await env.DOCS.get('documents/drop/drop.pdf')).toBeNull();
    const keepRows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'keep'));
    expect(keepRows.length).toBe(1);
  });

  it('rejects a resolve missing keepId', async () => {
    const res = await call(POST, 'POST', {
      action: 'resolve',
      deleteIds: ['x'],
    });
    expect(res.status).toBe(400);
  });
});
