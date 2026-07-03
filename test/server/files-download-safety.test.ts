import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/files/[id]';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function seed(id: string, contentType: string, filename: string) {
  const now = new Date();
  const r2Key = `documents/${id}/file`;
  await env.DOCS.put(r2Key, 'bytes');
  await getDb(env).insert(documents).values({
    id,
    title: id,
    category: 'Other',
    visibility: 'public', // public: skips auth so the test stays focused on headers
    r2Key,
    filename,
    sizeBytes: 5,
    contentType,
    uploadedAt: now,
    updatedAt: now,
  });
}

function get(id: string) {
  return GET({
    params: { id },
    request: new Request(`http://localhost/api/files/${id}`),
  } as never);
}

describe('file download safety', () => {
  it('serves non-PDF as an attachment with nosniff', async () => {
    await seed('dl-html', 'text/html', 'page.html');
    const res = await get('dl-html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('serves PDF inline with nosniff', async () => {
    await seed('dl-pdf', 'application/pdf', 'doc.pdf');
    const res = await get('dl-pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
  });

  it('strips control characters from the filename header', async () => {
    await seed('dl-ctrl', 'application/pdf', 'a\r\nb"c.pdf');
    const res = await get('dl-ctrl');
    const cd = res.headers.get('content-disposition')!;
    // The header necessarily wraps the filename in a quoted-string (RFC 6266),
    // so assert there's no injected CR/LF and no *stray* quote beyond that
    // structural pair — i.e. the sanitized name itself is quote-free.
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toBe('inline; filename="abc.pdf"');
  });
});
