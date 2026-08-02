import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { resolutions, motions, meetings } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  // Break the supersession chain before the bulk delete. supersedes_id is
  // ON DELETE RESTRICT and SQLite enforces it per-row immediately, so an
  // unqualified delete fails the moment any test leaves a valid chain behind:
  // the predecessor is reached while its successor still points at it.
  await db.update(resolutions).set({ supersedesId: null });
  await db.delete(resolutions);
  await db.delete(motions);
  await db.delete(meetings);
});

async function seedResolution(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(resolutions)
    .values({
      id,
      number: `R-2026-${id}`,
      title: `Resolution ${id}`,
      bodyMd: 'Body text.',
      effectiveDate: null,
      status: 'draft',
      adoptedByMotionId: null,
      supersedesId: null,
      visibility: 'board',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

describe('resolutions schema', () => {
  it('defaults a new resolution to draft and board visibility', async () => {
    await seedResolution('a');
    const rows = await getDb(env)
      .select()
      .from(resolutions)
      .where(eq(resolutions.id, 'a'));
    expect(rows[0].status).toBe('draft');
    expect(rows[0].visibility).toBe('board');
    expect(rows[0].effectiveDate).toBeNull();
    expect(rows[0].supersedesId).toBeNull();
  });

  it('rejects a duplicate resolution number', async () => {
    await seedResolution('a', { number: 'R-2026-01' });
    await expect(
      seedResolution('b', { number: 'R-2026-01' }),
    ).rejects.toThrow();
  });

  it('allows two resolutions to have no predecessor', async () => {
    // UNIQUE(supersedes_id) must not collide on NULL — SQLite treats NULLs as
    // distinct, and every unlinked resolution has a null predecessor.
    await seedResolution('a');
    await seedResolution('b');
    const rows = await getDb(env).select().from(resolutions);
    expect(rows.length).toBe(2);
  });

  it('refuses to let two resolutions supersede the same predecessor', async () => {
    await seedResolution('old', { status: 'in_force' });
    await seedResolution('new1', { supersedesId: 'old' });
    await expect(
      seedResolution('new2', { supersedesId: 'old' }),
    ).rejects.toThrow();
  });

  it('refuses to delete a resolution that something supersedes', async () => {
    const db = getDb(env);
    await seedResolution('old', { status: 'superseded' });
    await seedResolution('new', { supersedesId: 'old' });
    await expect(
      db.delete(resolutions).where(eq(resolutions.id, 'old')),
    ).rejects.toThrow();
    expect((await db.select().from(resolutions)).length).toBe(2);
  });

  it('nulls adopted_by_motion_id when the adopting motion is deleted', async () => {
    const db = getDb(env);
    await db.insert(meetings).values({
      id: 'm1',
      body: 'board',
      kind: 'regular',
      date: '2026-09-14',
      title: 'Sept',
      status: 'draft',
      visibility: 'board',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(motions).values({
      id: 'mo1',
      meetingId: 'm1',
      sequence: 1,
      text: 'Adopt R-2026-01',
      moverPersonId: null,
      secondPersonId: null,
      moverOwnerId: null,
      secondOwnerId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await seedResolution('a', { adoptedByMotionId: 'mo1' });
    await db.delete(motions).where(eq(motions.id, 'mo1'));
    const rows = await db.select().from(resolutions);
    expect(rows.length).toBe(1);
    expect(rows[0].adoptedByMotionId).toBeNull();
  });

  it('stores an in-force resolution with an effective date', async () => {
    await seedResolution('a', {
      status: 'in_force',
      effectiveDate: '2026-09-15',
    });
    const rows = await getDb(env).select().from(resolutions);
    expect(rows[0].status).toBe('in_force');
    expect(rows[0].effectiveDate).toBe('2026-09-15');
  });
});
