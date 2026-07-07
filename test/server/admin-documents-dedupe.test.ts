import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { eq } from 'drizzle-orm';
import { POST } from '../../src/pages/api/admin/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function upload(
  content: string,
  name: string,
  title: string,
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  form.set('file', new File([content], name, { type: 'application/pdf' }));
  form.set('title', title);
  form.set('category', 'Governing Documents');
  form.set('visibility', 'public');
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return POST({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'POST',
      body: form,
    }),
  } as never);
}

describe('upload guard', () => {
  it('persists a content hash on a clean upload', async () => {
    const res = await upload('unique-alpha', 'alpha.pdf', 'Alpha');
    expect(res.status).toBe(201);
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.title, 'Alpha'));
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks a byte-identical re-upload with 409 exact-duplicate', async () => {
    await upload('same-bytes-here', 'first.pdf', 'First');
    const res = await upload('same-bytes-here', 'second.pdf', 'Second');
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      existing: { title: string };
    };
    expect(body.error).toBe('exact-duplicate');
    expect(body.existing.title).toBe('First');
    const rows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.title, 'Second'));
    expect(rows.length).toBe(0);
  });

  it('warns on a near-duplicate, then accepts with confirmDuplicate=true', async () => {
    await upload(
      'body-one',
      'Meeting Minutes 2024.pdf',
      'Meeting Minutes 2024',
    );
    const warn = await upload(
      'body-two-different',
      'Meeting Minutes 2024.pdf',
      'Meeting Minutes 2024',
    );
    expect(warn.status).toBe(409);
    const wbody = (await warn.json()) as {
      warning: string;
      similar: unknown[];
    };
    expect(wbody.warning).toBe('near-duplicate');
    expect(wbody.similar.length).toBeGreaterThan(0);

    const ok = await upload(
      'body-two-different',
      'Meeting Minutes 2024.pdf',
      'Meeting Minutes 2024',
      { confirmDuplicate: 'true' },
    );
    expect(ok.status).toBe(201);
  });
});
