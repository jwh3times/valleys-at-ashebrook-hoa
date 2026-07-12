import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

const { twinMock } = vi.hoisted(() => ({ twinMock: vi.fn() }));
vi.mock('../../src/server/ai/twin', () => ({ generateTwin: twinMock }));

import { POST } from '../../src/pages/api/admin/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

const board = { authContext: { userId: 'b', role: 'board', propertyIds: [] } };

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function upload(title: string, name: string, type: string) {
  const form = new FormData();
  // Distinct bytes per upload so the exact-duplicate hash check never fires.
  form.set('file', new File([`content for ${name}`], name, { type }));
  form.set('title', title);
  form.set('category', 'Governing Documents');
  form.set('visibility', 'board');
  // confirmDuplicate skips the near-duplicate 409 path so this test is
  // independent of metadata dedupe scoring — it exercises twin behavior only.
  form.set('confirmDuplicate', 'true');
  return POST({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'POST',
      body: form,
    }),
    locals: board,
  } as never);
}

async function rowByTitle(title: string) {
  const rows = await getDb(env).select().from(documents);
  return rows.find((r) => r.title === title);
}

describe('POST /api/admin/documents — rag twin', () => {
  it("writes rag/<id>.md and rag_status 'ok' for a convertible upload", async () => {
    twinMock.mockResolvedValueOnce({
      markdown: '# extracted text',
      status: 'ok',
    });
    const res = await upload('Ok Doc', 'ok.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    const row = await rowByTitle('Ok Doc');
    expect(row?.ragStatus).toBe('ok');
    expect(await env.DOCS.get(`rag/${row!.id}.md`)).not.toBeNull();
  });

  it("records rag_status 'unsupported' with no twin, still 201 and downloadable", async () => {
    twinMock.mockResolvedValueOnce({ markdown: null, status: 'unsupported' });
    const res = await upload('Scan Doc', 'scan.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    const row = await rowByTitle('Scan Doc');
    expect(row?.ragStatus).toBe('unsupported');
    expect(await env.DOCS.get(`rag/${row!.id}.md`)).toBeNull();
    // The human-readable original is still stored (download unaffected).
    expect(await env.DOCS.get(row!.r2Key)).not.toBeNull();
  });

  it('still returns 201 if the twin step throws (best-effort, non-fatal)', async () => {
    twinMock.mockRejectedValueOnce(new Error('twin blew up'));
    const res = await upload('Resilient Doc', 'x.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    const row = await rowByTitle('Resilient Doc');
    expect(row?.ragStatus).toBe('unsupported');
  });
});
