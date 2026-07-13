import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/admin/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { fetchDocumentsFor } from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(documents).values({
    id: 'doc-unsupported',
    title: 'Scanned Deed',
    category: 'Maps & Deeds',
    visibility: 'board',
    r2Key: 'documents/doc-unsupported/d.pdf',
    filename: 'd.pdf',
    sizeBytes: 1,
    contentType: 'application/pdf',
    ragStatus: 'unsupported',
    uploadedAt: new Date(),
    updatedAt: new Date(),
  });
});

function req() {
  return new Request('http://localhost/api/admin/documents');
}

describe('GET /api/admin/documents', () => {
  it('returns documents including rag_status for a board caller', async () => {
    const res = await GET({
      request: req(),
      locals: { authContext: { userId: 'b', role: 'board', propertyIds: [] } },
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      ragStatus: string | null;
    }[];
    const row = body.find((d) => d.id === 'doc-unsupported');
    expect(row?.ragStatus).toBe('unsupported');
  });

  it('403s a non-board caller (fail-closed)', async () => {
    const res = await GET({
      request: req(),
      locals: {
        authContext: { userId: 'h', role: 'homeowner', propertyIds: [] },
      },
    } as never);
    expect(res.status).toBe(403);
  });

  it('the public documents read never exposes rag_status', async () => {
    const rows = await fetchDocumentsFor(env, 'board');
    for (const r of rows) expect('ragStatus' in r).toBe(false);
  });

  it('includes filename for each document', async () => {
    const res = await GET({
      request: req(),
      locals: { authContext: { userId: 'b', role: 'board', propertyIds: [] } },
    } as never);
    const body = (await res.json()) as { id: string; filename: string }[];
    const row = body.find((d) => d.id === 'doc-unsupported');
    expect(row?.filename).toBe('d.pdf');
  });
});
