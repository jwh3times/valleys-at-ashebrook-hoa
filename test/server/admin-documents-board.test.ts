import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
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

  it('rejects a disallowed extension with 415', async () => {
    const form = new FormData();
    form.set('file', new File(['x'], 'evil.html', { type: 'text/html' }));
    form.set('title', 'Evil');
    form.set('category', 'Policies');
    form.set('visibility', 'public');
    const res = await POST({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'POST',
        body: form,
      }),
    } as never);
    expect(res.status).toBe(415);
  });

  it('stores a server-derived content type, ignoring the client MIME', async () => {
    const form = new FormData();
    // Wrong/empty client MIME on a .csv — server should canonicalize to text/csv.
    form.set(
      'file',
      new File(['a,b'], 'roster.csv', { type: 'application/octet-stream' }),
    );
    form.set('title', 'Roster CSV');
    form.set('category', 'Policies');
    form.set('visibility', 'public');
    const res = await POST({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'POST',
        body: form,
      }),
    } as never);
    expect(res.status).toBe(201);
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.title, 'Roster CSV'));
    expect(row.contentType).toBe('text/csv');
  });
});
