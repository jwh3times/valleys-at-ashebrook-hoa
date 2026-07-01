import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', ownerIds: [] }),
}));

import { POST, DELETE } from '../../src/pages/api/admin/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin documents — board', () => {
  it('uploads a file to R2 and inserts a row', async () => {
    const form = new FormData();
    form.set(
      'file',
      new File(['hello-doc'], 'bylaws.pdf', { type: 'application/pdf' }),
    );
    form.set('title', 'Bylaws');
    form.set('category', 'Governing Documents');
    form.set('visibility', 'public');
    const res = await POST({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'POST',
        body: form,
      }),
    } as never);
    expect(res.status).toBe(201);
    const rows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.title, 'Bylaws'));
    expect(rows.length).toBe(1);
    expect(rows[0].visibility).toBe('public');
    const obj = await env.DOCS.get(rows[0].r2Key);
    expect(obj).not.toBeNull();
  });
});
