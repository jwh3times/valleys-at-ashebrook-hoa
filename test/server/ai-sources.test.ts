import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { toSources } from '../../src/server/ai/sources';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import type { AiSearchChunk } from '../../src/server/ai/search';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(documents).values({
    id: 'uuid-1',
    title: 'Collections Policy',
    category: 'Governing Documents',
    visibility: 'board',
    r2Key: 'documents/uuid-1/collections.pdf',
    filename: 'collections.pdf',
    sizeBytes: 10,
    contentType: 'application/pdf',
    uploadedAt: new Date(),
    updatedAt: new Date(),
  });
});

function chunk(folder: string): AiSearchChunk {
  return {
    id: 'c',
    score: 0.9,
    content: 'x',
    metadata: { filename: 'f.pdf', folder, timestamp: 1 },
  };
}

describe('toSources', () => {
  it('maps a documents/<uuid>/ folder to the real doc row + download link', async () => {
    const out = await toSources(env, [
      chunk('documents/uuid-1/collections.pdf'),
    ]);
    expect(out).toEqual([
      {
        id: 'uuid-1',
        title: 'Collections Policy',
        category: 'Governing Documents',
        href: '/api/files/uuid-1',
      },
    ]);
  });

  it('dedupes repeated chunks from the same document', async () => {
    const out = await toSources(env, [
      chunk('documents/uuid-1/collections.pdf'),
      chunk('documents/uuid-1/collections.pdf'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('ignores chunks whose uuid is not a known document', async () => {
    const out = await toSources(env, [chunk('documents/missing/x.pdf')]);
    expect(out).toEqual([]);
  });
});
