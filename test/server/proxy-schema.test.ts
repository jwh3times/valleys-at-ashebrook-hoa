import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { proxies } from '../../src/server/db/schema';
import {
  truncateAll,
  seedProperty,
  seedOwner,
  seedMeeting,
  seedElection,
  proxyRow,
} from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(truncateAll);

// drizzle-orm 0.45.2 wraps every D1 error in a DrizzleQueryError whose own
// `.message` is just "Failed query: ...params: ..." — the SQLite reason
// (CHECK/UNIQUE constraint failed) is one level down on `.cause.message`.
// Vitest's `toThrow(regex)` only inspects the top-level message, so it can't
// see the constraint name directly; this helper checks both levels.
async function expectRejectsWithReason(
  promise: Promise<unknown>,
  pattern: RegExp,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const err = caught as Error & { cause?: unknown };
  const text = [
    err.message,
    err.cause instanceof Error ? err.cause.message : '',
  ].join('\n');
  expect(text).toMatch(pattern);
}

describe('proxies schema', () => {
  beforeEach(async () => {
    await seedProperty('p1');
    await seedProperty('p2');
    await seedOwner('o1', 'p1');
    await seedMeeting('m1');
    await seedMeeting('m2');
    await seedElection('e1');
    await seedElection('e2');
  });

  it('rejects a proxy with neither occasion against a direct write', async () => {
    await expectRejectsWithReason(
      getDb(env).insert(proxies).values(proxyRow('x1')),
      /CHECK/i,
    );
  });

  it('rejects a proxy with both occasions against a direct write', async () => {
    await expectRejectsWithReason(
      getDb(env)
        .insert(proxies)
        .values(proxyRow('x1', { meetingId: 'm1', electionId: 'e1' })),
      /CHECK/i,
    );
  });

  it('accepts a meeting-scoped and an election-scoped proxy', async () => {
    const db = getDb(env);
    await db.insert(proxies).values(proxyRow('x1', { meetingId: 'm1' }));
    await db.insert(proxies).values(proxyRow('x2', { electionId: 'e1' }));
    const rows = await db.select().from(proxies);
    expect(rows).toHaveLength(2);
  });

  it('rejects a second proxy for the same lot at the same meeting', async () => {
    const db = getDb(env);
    await db.insert(proxies).values(proxyRow('x1', { meetingId: 'm1' }));
    await expectRejectsWithReason(
      db.insert(proxies).values(proxyRow('x2', { meetingId: 'm1' })),
      /UNIQUE/i,
    );
    // Control: a different occasion is allowed for the same lot.
    await db.insert(proxies).values(proxyRow('x3', { meetingId: 'm2' }));
  });

  it('rejects a second proxy for the same lot at the same election', async () => {
    const db = getDb(env);
    await db.insert(proxies).values(proxyRow('x1', { electionId: 'e1' }));
    await expectRejectsWithReason(
      db.insert(proxies).values(proxyRow('x2', { electionId: 'e1' })),
      /UNIQUE/i,
    );
    await db.insert(proxies).values(proxyRow('x3', { electionId: 'e2' }));
  });

  it('the generated 0014 SQL creates proxies with the one-occasion CHECK', () => {
    const m = env.MIGRATIONS!.find((x) => x.name.startsWith('0014'));
    expect(m).toBeDefined();
    const create = m!.queries.find(
      (q) => q.includes('CREATE TABLE') && q.includes('`proxies`'),
    );
    expect(create).toBeDefined();
    expect(create).toMatch(/CHECK/i);
  });

  it('the generated 0014 SQL adds the three proxy_id columns WITHOUT an ON DELETE action', () => {
    const m = env.MIGRATIONS!.find((x) => x.name.startsWith('0014'));
    expect(m).toBeDefined();
    const alters = m!.queries.filter(
      (q) => q.includes('ALTER TABLE') && q.includes('proxy_id'),
    );
    expect(alters).toHaveLength(3);
    for (const alter of alters) {
      // The FK itself IS emitted; only the action is dropped by drizzle-kit on
      // ALTER-added columns — same pin as board_terms.election_id in
      // election-schema.test.ts. If a future drizzle-kit starts emitting the
      // action, this fails and the schema comment gets updated deliberately.
      expect(alter).toMatch(/REFERENCES/i);
      expect(alter).not.toMatch(/ON DELETE/i);
    }
  });
});
