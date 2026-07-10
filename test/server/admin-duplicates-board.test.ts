import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { eq, inArray } from 'drizzle-orm';
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
  visibility: 'public' | 'homeowner' | 'board' = 'board',
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
      visibility,
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
      exact: {
        members: { id: string; contentHash: string }[];
        suggestedKeepId: string;
        matchKind: string;
        contentHash: string;
        sameTier: boolean;
        autoResolvable: boolean;
        deleteIds: string[];
        recommendation: string;
      }[];
      remaining: number;
    };
    const group = body.exact.find((g) => g.members.some((m) => m.id === 'd1'));
    expect(group).toBeTruthy();
    expect(group!.members.map((m) => m.id).sort()).toEqual(['d1', 'd2']);
    expect(group!.suggestedKeepId).toBe('d1');
    expect(group!.matchKind).toBe('exact');
    expect(group!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      group!.members.every((m) => m.contentHash === group!.contentHash),
    ).toBe(true);
    expect(group!.sameTier).toBe(true);
    expect(group!.autoResolvable).toBe(true);
    expect(group!.deleteIds).toEqual(['d2']);
    expect(group!.recommendation).toMatch(/same-tier exact/i);
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'd1'));
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits a group whose members are all kept-verified', async () => {
    // Force a valid shared hash so the exact group forms deterministically,
    // independent of the capped lazy backfill / row ordering.
    await seed('ver-a', 'verified-a', 'ver-a.pdf', 'a'.repeat(64));
    await seed('ver-b', 'verified-b', 'ver-b.pdf', 'a'.repeat(64));
    await getDb(env)
      .update(documents)
      .set({ keepVerifiedAt: new Date(), keepVerifiedBy: 'b' })
      .where(inArray(documents.id, ['ver-a', 'ver-b']));
    const res = await call(GET, 'GET');
    const body = (await res.json()) as {
      exact: { members: { id: string }[] }[];
    };
    const group = body.exact.find((g) =>
      g.members.some((m) => m.id === 'ver-a'),
    );
    expect(group).toBeUndefined();
  });

  it('keeps a partially-verified group and reports verifiedAt per member', async () => {
    await seed('part-a', 'partial-identical', 'part-a.pdf', null);
    await seed('part-b', 'partial-identical', 'part-b.pdf', null);
    await getDb(env)
      .update(documents)
      .set({ keepVerifiedAt: new Date(), keepVerifiedBy: 'b' })
      .where(eq(documents.id, 'part-a'));
    const res = await call(GET, 'GET');
    const body = (await res.json()) as {
      exact: { members: { id: string; verifiedAt: string | null }[] }[];
    };
    const group = body.exact.find((g) =>
      g.members.some((m) => m.id === 'part-a'),
    );
    expect(group).toBeTruthy();
    const a = group!.members.find((m) => m.id === 'part-a')!;
    const b = group!.members.find((m) => m.id === 'part-b')!;
    expect(a.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.verifiedAt).toBeNull();
  });

  it('reports cross-tier exact groups as manual-review, not auto-resolvable', async () => {
    await seed(
      'cx-public',
      'cross-tier-bytes',
      'cross-public.pdf',
      null,
      'public',
    );
    await seed(
      'cx-board',
      'cross-tier-bytes',
      'cross-board.pdf',
      null,
      'board',
    );
    const res = await call(GET, 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exact: {
        members: { id: string }[];
        sameTier: boolean;
        autoResolvable: boolean;
        deleteIds: string[];
        recommendation: string;
      }[];
    };
    const group = body.exact.find((g) =>
      g.members.some((m) => m.id === 'cx-public'),
    );
    expect(group).toBeTruthy();
    expect(group!.members.map((m) => m.id).sort()).toEqual([
      'cx-board',
      'cx-public',
    ]);
    expect(group!.sameTier).toBe(false);
    expect(group!.autoResolvable).toBe(false);
    expect(group!.deleteIds).toEqual([]);
    expect(group!.recommendation).toMatch(/visibility tiers/i);
  });

  it('repairs invalid stored hashes instead of grouping them as exact matches', async () => {
    await seed('bad-hash-a', 'different-a', 'bad-a.pdf', 'content_hash');
    await seed('bad-hash-b', 'different-b', 'bad-b.pdf', 'content_hash');
    const res = await call(GET, 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exact: { members: { id: string; contentHash: string }[] }[];
    };
    const badGroup = body.exact.find(
      (g) =>
        g.members.some((m) => m.id === 'bad-hash-a') &&
        g.members.some((m) => m.id === 'bad-hash-b'),
    );
    expect(badGroup).toBeUndefined();

    const rows = await getDb(env).select().from(documents);
    const repaired = rows.filter((r) =>
      ['bad-hash-a', 'bad-hash-b'].includes(r.id),
    );
    expect(repaired.map((r) => r.contentHash)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ]),
    );
  });

  it('keeps reporting duplicates when one pending hash cannot be read from R2', async () => {
    const now = new Date();
    await getDb(env).insert(documents).values({
      id: 'missing-r2',
      title: 'missing',
      category: 'Other',
      visibility: 'board',
      r2Key: 'documents/missing-r2/missing.pdf',
      filename: 'missing.pdf',
      sizeBytes: 123,
      contentType: 'application/pdf',
      contentHash: null,
      uploadedAt: now,
      updatedAt: now,
    });
    await seed('after-missing-a', 'still-identical', 'after.pdf', null);
    await seed('after-missing-b', 'still-identical', 'after(1).pdf', null);

    const res = await call(GET, 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exact: { members: { id: string; contentHash: string | null }[] }[];
      remaining: number;
    };
    const group = body.exact.find((g) =>
      g.members.some((m) => m.id === 'after-missing-a'),
    );
    expect(group).toBeTruthy();
    expect(group!.members.map((m) => m.id).sort()).toEqual([
      'after-missing-a',
      'after-missing-b',
    ]);
    expect(body.remaining).toBeGreaterThanOrEqual(1);

    const [missing] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'missing-r2'));
    expect(missing.contentHash).toBeNull();
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
