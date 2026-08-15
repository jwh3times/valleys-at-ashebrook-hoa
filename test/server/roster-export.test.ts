import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { auditEvents, accessEvents } from '../../src/server/db/audit-schema';
import type { AuthContext } from '../../src/server/authz/guards';
import { req } from './fixtures';

// Board caller via the vi.mock idiom used throughout test/server/*-board.test.ts.
// getAuthContext is wrapped in vi.fn() (rather than a plain arrow function) so
// the "anonymous" test below can override it for one call — this file needs
// BOTH a board caller (the common case) and a genuinely anonymous one, and the
// mock is file-wide.
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: vi.fn(
    async (): Promise<AuthContext | null> =>
      legacyAuthContext('b', 'board', []),
  ),
}));

import { POST } from '../../src/pages/api/admin/roster-export';
import { getAuthContext, legacyAuthContext } from '../../src/server/authz/context';
import { fetchAdminRoster } from '../../src/server/roster/reads';
import { associationDateIso } from '../../src/lib/format';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const url = 'http://localhost/api/admin/roster-export';
const now = new Date();

async function seedAccount(id: string) {
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

beforeEach(async () => {
  const db = getDb(env);
  // access_events references audit_events (restrict); audit_events
  // references users (restrict) and itself (restrict, self-reference safe to
  // clear whole-table per fixtures.ts's note on resolutions' self-reference).
  await db.delete(accessEvents);
  await db.delete(auditEvents);
  await db.delete(users);
});

describe('roster-export admin route', () => {
  it('returns the roster and writes exactly one Access Event for the export', async () => {
    await seedAccount('b');
    const res = await POST(req(url, 'POST'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generatedAt: number;
      roster: unknown;
    };
    expect(typeof body.generatedAt).toBe('number');
    expect(body.roster).toBeDefined();

    const events = await getDb(env).select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0].family).toBe('access');
    expect(events[0].eventKind).toBe('roster_export');
    expect(events[0].operationKey).not.toBeNull();
    expect(events[0].actorAccountId).toBe('b');

    const details = await getDb(env)
      .select()
      .from(accessEvents)
      .where(eq(accessEvents.eventId, events[0].id));
    expect(details).toHaveLength(1);
    expect(details[0].requestedAction).toBe('roster_export');
    expect(details[0].outcome).toBe('allowed');
  });

  it('writes two Access Events for two exports', async () => {
    await seedAccount('b');
    const first = await POST(req(url, 'POST'));
    const second = await POST(req(url, 'POST'));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const events = await getDb(env).select().from(auditEvents);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it('an ordinary roster read writes no Access Event', async () => {
    // /api/admin/roster is a sibling ADR 0022 phase-3b surface declared in
    // test/unit/adr0022-model-boundary.test.ts's NEW_MODEL_SURFACE, but it
    // belongs to a different implementation slice and does not exist in this
    // worktree yet. fetchAdminRoster is the exact read that route and this
    // export both share (see roster-export.ts), so calling it directly proves
    // the same property: an ordinary single-record read never touches the
    // ledger. Only the export action does.
    await fetchAdminRoster(env, associationDateIso());
    const events = await getDb(env).select().from(auditEvents);
    expect(events).toHaveLength(0);
  });

  it('refuses an anonymous caller with 401', async () => {
    vi.mocked(getAuthContext).mockResolvedValueOnce(null);
    const res = await POST(req(url, 'POST'));
    expect(res.status).toBe(401);
    const events = await getDb(env).select().from(auditEvents);
    expect(events).toHaveLength(0);
  });
});
