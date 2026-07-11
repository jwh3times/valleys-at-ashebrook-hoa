import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { DELETE } from '../../src/pages/api/admin/documents';
import { POST as duplicatesPost } from '../../src/pages/api/admin/duplicates';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function seedDoc(id: string) {
  await getDb(env)
    .insert(documents)
    .values({
      id,
      title: id,
      category: 'Governing Documents',
      visibility: 'public',
      r2Key: `documents/${id}/f.pdf`,
      filename: 'f.pdf',
      sizeBytes: 3,
      contentType: 'application/pdf',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
  await env.DOCS.put(`documents/${id}/f.pdf`, 'pdf');
  await env.DOCS.put(`rag/${id}.md`, '# md');
}

describe('rag twin is deleted with its document', () => {
  it('DELETE removes both the file and rag/<id>.md', async () => {
    await seedDoc('del-1');
    const res = await DELETE({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'del-1' }),
      }),
    } as never);
    expect(res.status).toBe(204);
    expect(await env.DOCS.get('documents/del-1/f.pdf')).toBeNull();
    expect(await env.DOCS.get('rag/del-1.md')).toBeNull();
  });

  it('duplicate resolve removes rag/<id>.md for each deleted id', async () => {
    await seedDoc('keep-1');
    await seedDoc('drop-1');
    const res = await duplicatesPost({
      request: new Request('http://localhost/api/admin/duplicates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          keepIds: ['keep-1'],
          deleteIds: ['drop-1'],
        }),
      }),
    } as never);
    expect(res.status).toBe(204);
    expect(await env.DOCS.get('rag/drop-1.md')).toBeNull();
    expect(await env.DOCS.get('rag/keep-1.md')).not.toBeNull();
  });
});
