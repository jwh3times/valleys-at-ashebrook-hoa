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
    // A single-draft fixture with a bare not.toContain assertion would also
    // pass against a broken includeHistoric that returns nothing at all —
    // seed a non-draft sibling and assert the exact returned set instead.
    await seed('a', { status: 'draft', visibility: 'board' });
    await seed('b', { status: 'superseded', visibility: 'board' });
    const rows = await fetchResolutionsFor(env, 'board', {
      includeHistoric: true,
    });
    expect(rows.map((r) => r.id)).toEqual(['b']);
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
    // Exactly one entry (y): the walk visits y, then sees x again (the
    // starting row) and stops. `0 < length < 10` would also pass a walk
    // that stops after a single arbitrary hop for the wrong reason — pin
    // the exact, correct length instead.
    expect(x!.chain.length).toBe(1);
  });

  it('shows drafts to the admin read', async () => {
    await seed('a', { status: 'draft', visibility: 'board' });
    await seed('b', { status: 'in_force', visibility: 'public' });
    const rows = await fetchAdminResolutions(env);
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('masks supersededByNumber when the successor is out of tier', async () => {
    await seed('old', { status: 'superseded', visibility: 'public' });
    await seed('newer', {
      status: 'in_force',
      visibility: 'board',
      supersedesId: 'old',
    });

    const visitorRows = await fetchResolutionsFor(env, 'visitor', {
      includeHistoric: true,
    });
    const oldAsVisitor = visitorRows.find((r) => r.id === 'old');
    expect(oldAsVisitor).toBeDefined();
    expect(oldAsVisitor?.supersededByNumber).toBeNull();

    const boardRows = await fetchResolutionsFor(env, 'board', {
      includeHistoric: true,
    });
    const oldAsBoard = boardRows.find((r) => r.id === 'old');
    expect(oldAsBoard).toBeDefined();
    expect(oldAsBoard?.supersededByNumber).toBe('R-2026-newer');
  });

  it('masks the immediate predecessor and supersedesId when it alone is out of tier', async () => {
    // The 2-row shape the brief's prose actually describes — a public
    // resolution DIRECTLY superseding a board-only one, so the masked link
    // is chain[0] itself, not a deeper link behind a visible one. Also the
    // exact fixture Task 4's `supersede` action produces.
    await seed('pred', { status: 'superseded', visibility: 'board' });
    await seed('succ', {
      status: 'in_force',
      visibility: 'public',
      supersedesId: 'pred',
    });

    const visitorRows = await fetchResolutionsFor(env, 'visitor');
    const succAsVisitor = visitorRows.find((r) => r.id === 'succ');
    expect(succAsVisitor).toBeDefined();
    expect(succAsVisitor?.chain).toEqual([
      { id: null, number: null, title: null, visible: false },
    ]);
    // supersedesId must not hand a visitor the same hidden identity chain[0]
    // just masked, from the other direction.
    expect(succAsVisitor?.supersedesId).toBeNull();

    const boardRows = await fetchResolutionsFor(env, 'board');
    const succAsBoard = boardRows.find((r) => r.id === 'succ');
    expect(succAsBoard).toBeDefined();
    expect(succAsBoard?.supersedesId).toBe('pred');
  });

  it('does not truncate a later chain in the same call using leftover state from an earlier one', async () => {
    // Reuses the out-of-tier fixture: `current` -> `mid` -> `hidden`. With
    // includeHistoric, BOTH `current` and `mid` come back as their own
    // top-level entries in ONE call, and both chains pass through `hidden`.
    // A `visited` set that is not freshly created per buildChain call (e.g.
    // hoisted to module scope, since a Worker isolate reuses one module
    // instance across many requests) would have `hidden` already marked
    // "seen" by the time mid's own walk reaches it, from processing
    // current's walk first, and wrongly truncate mid's chain to nothing.
    await seed('hidden', { status: 'superseded', visibility: 'board' });
    await seed('mid', {
      status: 'superseded',
      visibility: 'public',
      supersedesId: 'hidden',
    });
    await seed('current', {
      status: 'in_force',
      visibility: 'public',
      supersedesId: 'mid',
    });

    const rows = await fetchResolutionsFor(env, 'visitor', {
      includeHistoric: true,
    });
    const current = rows.find((r) => r.id === 'current');
    const mid = rows.find((r) => r.id === 'mid');
    expect(current).toBeDefined();
    expect(mid).toBeDefined();
    expect(current?.chain.length).toBe(2);
    expect(mid?.chain.length).toBe(1);
    expect(mid?.chain[0]).toEqual({
      id: null,
      number: null,
      title: null,
      visible: false,
    });
  });

  it('does not mask any tier on the admin read, even the out-of-tier fixture', async () => {
    await seed('hidden', { status: 'superseded', visibility: 'board' });
    await seed('mid', {
      status: 'superseded',
      visibility: 'public',
      supersedesId: 'hidden',
    });
    await seed('current', {
      status: 'in_force',
      visibility: 'public',
      supersedesId: 'mid',
    });

    const rows = await fetchAdminResolutions(env);
    const current = rows.find((r) => r.id === 'current');
    expect(current).toBeDefined();
    expect(current?.chain[1]).toEqual({
      id: 'hidden',
      number: 'R-2026-hidden',
      title: 'Resolution hidden',
      visible: true,
    });
    expect(current?.supersedesId).toBe('mid');
  });
});
