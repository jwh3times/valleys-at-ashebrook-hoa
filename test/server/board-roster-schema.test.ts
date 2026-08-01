import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { boardPeople, boardTerms, users } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(boardTerms);
  await db.delete(boardPeople);
  await db.delete(users);
});

function userRow(id: string) {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    role: 'board',
  };
}

describe('board roster schema', () => {
  it('stores a person with no site account and no office', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(boardPeople).values({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db
      .select()
      .from(boardPeople)
      .where(eq(boardPeople.id, 'p1'));
    expect(rows.length).toBe(1);
    expect(rows[0].fullName).toBe('A. Reyes');
    expect(rows[0].userId).toBeNull();
  });

  it('stores two terms for one person, the open one with a null end', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(boardPeople).values({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(boardTerms).values([
      {
        id: 't1',
        personId: 'p1',
        title: 'Treasurer',
        termStart: '2024-01-01',
        termEnd: '2025-12-31',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 't2',
        personId: 'p1',
        title: null,
        termStart: '2027-01-01',
        termEnd: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const rows = await db
      .select()
      .from(boardTerms)
      .where(eq(boardTerms.personId, 'p1'));
    expect(rows.length).toBe(2);
    const open = rows.filter((r) => r.termEnd === null);
    expect(open.length).toBe(1);
    expect(open[0].title).toBeNull();
  });

  it('refuses to delete a person who has a term on record', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(boardPeople).values({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(boardTerms).values({
      id: 't1',
      personId: 'p1',
      title: 'Treasurer',
      termStart: '2024-01-01',
      termEnd: null,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.delete(boardPeople).where(eq(boardPeople.id, 'p1')),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(boardPeople)
      .where(eq(boardPeople.id, 'p1'));
    expect(rows.length).toBe(1);
  });

  it('nulls out user_id, not the person, when the linked site account is deleted', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(users).values(userRow('u1'));
    await db.insert(boardPeople).values({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: 'u1',
      createdAt: now,
      updatedAt: now,
    });

    await db.delete(users).where(eq(users.id, 'u1'));

    const rows = await db
      .select()
      .from(boardPeople)
      .where(eq(boardPeople.id, 'p1'));
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBeNull();
  });
});
