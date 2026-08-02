import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { resolutions } from '../../src/server/db/schema';
import {
  fetchResolutionsFor,
  fetchAdminResolutions,
} from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  // supersedes_id is ON DELETE RESTRICT and SQLite enforces it per-row
  // immediately, so an unqualified delete fails the moment any test leaves a
  // valid chain behind. Break links first.
  await db.update(resolutions).set({ supersedesId: null });
  await db.delete(resolutions);
});

async function seed(id: string, overrides: Record<string, unknown> = {}) {
  await getDb(env)
    .insert(resolutions)
    .values({
      id,
      number: `R-2026-${id}`,
      title: `Resolution ${id}`,
      bodyMd: 'Body text.',
      effectiveDate: null,
      status: 'in_force',
      adoptedByMotionId: null,
      supersedesId: null,
      visibility: 'public',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

describe('resolution read helpers', () => {
  it('hides drafts from a visitor', async () => {
    await seed('a', { status: 'draft', visibility: 'public' });
    expect((await fetchResolutionsFor(env, 'visitor')).length).toBe(0);
  });

  it('hides drafts from a BOARD caller too', async () => {
    await seed('a', { status: 'draft', visibility: 'board' });
    await seed('b', { status: 'in_force', visibility: 'board' });
    const rows = await fetchResolutionsFor(env, 'board');
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('hides drafts even when includeHistoric is set', async () => {
    await seed('a', { status: 'draft', visibility: 'board' });
    const rows = await fetchResolutionsFor(env, 'board', {
      includeHistoric: true,
    });
    expect(rows.map((r) => r.id)).not.toContain('a');
  });

  it('returns only in-force resolutions by default', async () => {
    await seed('a', { status: 'in_force' });
    await seed('b', { status: 'superseded' });
    await seed('c', { status: 'repealed' });
    const rows = await fetchResolutionsFor(env, 'board');
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('returns superseded and repealed when includeHistoric is set', async () => {
    await seed('a', { status: 'in_force' });
    await seed('b', { status: 'superseded' });
    await seed('c', { status: 'repealed' });
    const rows = await fetchResolutionsFor(env, 'board', {
      includeHistoric: true,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('applies the visibility tier to non-draft resolutions', async () => {
    await seed('pub', { status: 'in_force', visibility: 'public' });
    await seed('ho', { status: 'in_force', visibility: 'homeowner' });
    await seed('bd', { status: 'in_force', visibility: 'board' });
    expect(
      (await fetchResolutionsFor(env, 'visitor')).map((r) => r.id),
    ).toEqual(['pub']);
    expect(
      (await fetchResolutionsFor(env, 'homeowner')).map((r) => r.id).sort(),
    ).toEqual(['ho', 'pub']);
    expect((await fetchResolutionsFor(env, 'board')).length).toBe(3);
  });

  it('builds the supersession chain oldest-last', async () => {
    await seed('r1', { status: 'superseded', visibility: 'public' });
    await seed('r2', {
      status: 'superseded',
      visibility: 'public',
      supersedesId: 'r1',
    });
    await seed('r3', {
      status: 'in_force',
      visibility: 'public',
      supersedesId: 'r2',
    });
    const rows = await fetchResolutionsFor(env, 'visitor');
    const r3 = rows.find((r) => r.id === 'r3');
    expect(r3).toBeDefined();
    expect(r3?.chain.map((l) => l.id)).toEqual(['r2', 'r1']);
    expect(r3?.chain.every((l) => l.visible)).toBe(true);
  });

  it('renders an out-of-tier chain link as not visible, with no number or title', async () => {
    // The oldest link — board-only, must never be identifiable to a visitor.
    await seed('hidden', { status: 'superseded', visibility: 'board' });
    // A public resolution superseding the board-only one: the visible link
    // whose OWN predecessor is the one that must be masked.
    await seed('mid', {
      status: 'superseded',
      visibility: 'public',
      supersedesId: 'hidden',
    });
    // The in-force resolution under test, superseding `mid`.
    await seed('current', {
      status: 'in_force',
      visibility: 'public',
      supersedesId: 'mid',
    });
    const rows = await fetchResolutionsFor(env, 'visitor');
    const current = rows.find((r) => r.id === 'current');
    expect(current).toBeDefined();
    expect(current?.chain.length).toBe(2);
    expect(current?.chain[0]).toEqual({
      id: 'mid',
      number: 'R-2026-mid',
      title: 'Resolution mid',
      visible: true,
    });
    expect(current?.chain[1]).toEqual({
      id: null,
      number: null,
      title: null,
      visible: false,
    });
  });

  it('terminates on a cycle rather than looping forever', async () => {
    const db = getDb(env);
    // Insert two rows pointing at each other directly with Drizzle — the
    // actions in Task 4 make this unreachable through the API, which is why
    // the read path must defend itself independently. Insert without the
    // cyclic link first (the UNIQUE(supersedes_id) + FK constraints require
    // both rows to exist before either can point at the other), then patch
    // both rows to complete the cycle.
    await seed('x', { status: 'in_force', visibility: 'public' });
    await seed('y', { status: 'superseded', visibility: 'public' });
    await db
      .update(resolutions)
      .set({ supersedesId: 'y' })
      .where(eq(resolutions.id, 'x'));
    await db
      .update(resolutions)
      .set({ supersedesId: 'x' })
      .where(eq(resolutions.id, 'y'));

    const rows = await fetchResolutionsFor(env, 'visitor');
    const x = rows.find((r) => r.id === 'x');
    expect(x).toBeDefined();
    // Must terminate rather than hang/stack-overflow; exact truncation point
    // is an implementation detail as long as it stops.
    expect(x!.chain.length).toBeGreaterThan(0);
    expect(x!.chain.length).toBeLessThan(10);
  });

  it('shows drafts to the admin read', async () => {
    await seed('a', { status: 'draft', visibility: 'board' });
    await seed('b', { status: 'in_force', visibility: 'public' });
    const rows = await fetchAdminResolutions(env);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});
