import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import type { AuthContext, Capability } from '../../src/server/authz/guards';
import { legacyAuthContext } from '../../src/server/authz/context';
import { GET as getAccessDenials } from '../../src/pages/api/admin/access-denials';
import { GET as getAuditIntegrity } from '../../src/pages/api/admin/audit-integrity';

/**
 * access-denials.ts and audit-integrity.ts are two of the three
 * System-Administrator-only compliance surfaces (#205, #217). Both are plain
 * reads over the ledger, so these tests seed audit_events/access_events rows
 * directly with raw SQL rather than driving them through a mutation route.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const denialsUrl = 'http://localhost/api/admin/access-denials';
const integrityUrl = 'http://localhost/api/admin/audit-integrity';

const TABLES_TO_CLEAR = ['access_events', 'audit_events', 'users'];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of TABLES_TO_CLEAR) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
});

async function seedAccount(id: string) {
  const now = new Date();
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

async function seedAccessEvent(opts: {
  id: string;
  outcome: 'allowed' | 'denied';
  reasonCode?: string | null;
}) {
  const actorId = `actor-${opts.id}`;
  await seedAccount(actorId);
  await env.DATABASE.prepare(
    `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
     VALUES (?, 'access', 'grant_precondition_revalidation', ?, 0, 'account', ?, ?, ?)`,
  )
    .bind(opts.id, `corr-${opts.id}`, actorId, `opkey-${opts.id}`, Date.now())
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO access_events (event_id, access_grant_id, target_account_id, grant_type, requested_action, outcome, reason_code)
     VALUES (?, NULL, ?, 'board', 'grant_precondition_revalidation', ?, ?)`,
  )
    .bind(opts.id, actorId, opts.outcome, opts.reasonCode ?? null)
    .run();
}

function systemAdminContext(): AuthContext {
  return {
    userId: 'sa',
    personId: 'p-sa',
    capabilities: new Set<Capability>([
      'systemAdmin',
      'board',
      'member',
      'redactionAuthorize',
      'redactionCleanup',
      'accessDenialDetail',
      'auditIntegrityViews',
    ]),
    lotIds: [],
    contentTier: 'board',
    hasCurrentBoardTerm: false,
    role: 'board',
    propertyIds: [],
  };
}

function req(url: string, ctx: AuthContext | null) {
  return {
    request: new Request(url, { method: 'GET' }),
    locals: { authContext: ctx },
  } as never;
}

describe('access-denials admin route', () => {
  it('returns a seeded denied access event and excludes an allowed one', async () => {
    await seedAccessEvent({
      id: 'ev-denied',
      outcome: 'denied',
      reasonCode: 'qualifying_term_invalid',
    });
    await seedAccessEvent({ id: 'ev-allowed', outcome: 'allowed' });

    const res = await getAccessDenials(req(denialsUrl, systemAdminContext()));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      id: string;
      reason_code: string | null;
      event_kind: string;
    }[];
    expect(rows.map((r) => r.id)).toEqual(['ev-denied']);
    expect(rows[0].reason_code).toBe('qualifying_term_invalid');
    expect(rows[0].event_kind).toBe('grant_precondition_revalidation');
  });

  it('refuses a plain board caller', async () => {
    const res = await getAccessDenials(
      req(denialsUrl, legacyAuthContext('b', 'board', [])),
    );
    expect(res.status).toBe(403);
  });
});

describe('audit-integrity admin route', () => {
  it('returns empty arrays on a clean database', async () => {
    const res = await getAuditIntegrity(
      req(integrityUrl, systemAdminContext()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auditViolations: unknown[];
      boardEligibilityViolations: unknown[];
    };
    expect(body.auditViolations).toEqual([]);
    expect(body.boardEligibilityViolations).toEqual([]);
  });

  it('surfaces a detail-cardinality violation for an event with no typed detail row', async () => {
    await seedAccount('actor-orphan');
    await env.DATABASE.prepare(
      `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
       VALUES ('ev-orphan', 'roster_change', 'ownership_created', 'corr-orphan', 0, 'account', 'actor-orphan', 'opkey-orphan', ?)`,
    )
      .bind(Date.now())
      .run();

    try {
      const res = await getAuditIntegrity(
        req(integrityUrl, systemAdminContext()),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        auditViolations: { event_id: string; violation: string }[];
      };
      expect(body.auditViolations).toContainEqual({
        event_id: 'ev-orphan',
        violation: 'detail_cardinality',
      });
    } finally {
      // Clean up the deliberately-invalid row so it doesn't linger.
      await env.DATABASE.prepare('DELETE FROM audit_events WHERE id = ?')
        .bind('ev-orphan')
        .run();
    }
  });

  it('refuses a plain board caller', async () => {
    const res = await getAuditIntegrity(
      req(integrityUrl, legacyAuthContext('b', 'board', [])),
    );
    expect(res.status).toBe(403);
  });
});
