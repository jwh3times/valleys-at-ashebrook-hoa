import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { reports } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('reports table', () => {
  it('round-trips a report row', async () => {
    const db = getDb(env);
    await db.insert(reports).values({
      id: 'r1',
      topic: 'Rentals & leasing',
      templateKey: 'rentals',
      contentMd: '## Summary\nBody',
      sourcesJson: JSON.stringify([
        { id: 'd1', title: 'CCRs', category: 'Governing Documents' },
      ]),
      createdAt: new Date(),
      createdBy: 'user-1',
    });
    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(1);
    expect(rows[0].templateKey).toBe('rentals');
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('allows a null template key for freeform reports', async () => {
    const db = getDb(env);
    await db.insert(reports).values({
      id: 'r2',
      topic: 'solar panels',
      templateKey: null,
      contentMd: 'x',
      sourcesJson: '[]',
      createdAt: new Date(),
      createdBy: 'user-1',
    });
    const row = (await db.select().from(reports)).find((r) => r.id === 'r2');
    expect(row?.templateKey).toBeNull();
  });
});
