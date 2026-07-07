import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('documents.content_hash column', () => {
  it('stores and reads back a content hash', async () => {
    const now = new Date();
    await getDb(env).insert(documents).values({
      id: 'doc-hash-1',
      title: 'Hashed',
      category: 'Other',
      visibility: 'board',
      r2Key: 'documents/doc-hash-1/x.pdf',
      filename: 'x.pdf',
      sizeBytes: 3,
      contentType: 'application/pdf',
      contentHash: 'abc123',
      uploadedAt: now,
      updatedAt: now,
    });
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'doc-hash-1'));
    expect(row.contentHash).toBe('abc123');
  });
});
