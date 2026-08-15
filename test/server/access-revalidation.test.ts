import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { deriveAccess } from '../../src/server/authz/derive';
import { getAuthContext } from '../../src/server/authz/context';
import { resetRoster, seedRoster } from './dual-fixtures';

// The recording tests below drive the real `getAuthContext` seam; only the
// session is synthesized.
let sessionUserId: string | null = null;
vi.mock('../../src/server/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: async () =>
        sessionUserId
          ? { user: { id: sessionUserId, role: 'homeowner' } }
          : null,
    },
  }),
}));

/**
 * ADR 0022 phase 3a (#217): a stored Board grant is re-validated at evaluation
 * and never trusted from the write path (#200).
 *
 * The scenario is a grant the mutation boundary should have ended and did not —
 * a term that lapsed, was cancelled, or was voided while its access grant
 * stayed live. Evaluation refuses it, and the refusal is recorded because it
 * says something about the write path rather than about the caller.
 */

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  // Order matters: the audit rows reference users, and resetRoster leaves
  // users alone (the parity suite clears it separately for the same reason).
  for (const t of ['access_events', 'audit_events']) {
    await getDb(env).run(sql.raw(`DELETE FROM ${t}`));
  }
  await resetRoster();
  await getDb(env).run(sql.raw('DELETE FROM users'));
});

/**
 * One account, linked to one Person, holding a Board grant qualified by one
 * term. Built through the shared dual-shape fixture builder rather than raw
 * INSERTs so this file cannot drift from the roster shape the parity suite and
 * the backfill agree on.
 */
async function seedBoardGrant(opts: {
  scheduledEndDay: string;
  cancelled?: boolean;
  voided?: boolean;
}) {
  await seedRoster({
    lots: [{ id: 'lot-1', owners: [{ id: 'own-1', name: 'Board Member' }] }],
    accounts: [
      {
        id: 'acct-1',
        role: 'board',
        linkedTo: 'own-1',
        grants: ['board'],
        boardTerm: {
          startDay: '2026-01-01',
          scheduledEndDay: opts.scheduledEndDay,
          lotId: 'lot-1',
        },
      },
    ],
  });
  // The builder writes a clean term; these tests need one the mutation boundary
  // failed to clean up, which is the whole scenario.
  // cancelled_at must pair with cancelled_day, and a cancellation must precede
  // the start day — a withdrawal after service began is an early end instead.
  if (opts.cancelled)
    await getDb(env).run(
      sql`UPDATE board_service_terms
          SET cancelled_at = 1, cancelled_day = '2025-12-01'`,
    );
  if (opts.voided)
    await getDb(env).run(sql`UPDATE board_service_terms SET voided_at = 1`);
}

const grantId = async () =>
  (
    await getDb(env).all<{ id: string }>(
      sql`SELECT id FROM access_grants WHERE grant_type = 'board'`,
    )
  )[0]?.id;

describe('re-validating a stored Board grant', () => {
  it('grants board while the qualifying term is current', async () => {
    await seedBoardGrant({ scheduledEndDay: '2027-01-01' });
    const access = await deriveAccess(env, 'acct-1', DAY);
    expect(access.capabilities.has('board')).toBe(true);
    expect(access.invalidBoardGrantId).toBeNull();
  });

  it('refuses a grant whose term has already ended', async () => {
    // The mutation boundary should have ended this grant. It did not, and
    // evaluation is the backstop.
    await seedBoardGrant({ scheduledEndDay: '2026-02-01' });
    const access = await deriveAccess(env, 'acct-1', DAY);
    expect(access.capabilities.has('board')).toBe(false);
    expect(access.invalidBoardGrantId).toBe(await grantId());
  });

  it('refuses a grant whose term was cancelled', async () => {
    await seedBoardGrant({ scheduledEndDay: '2027-01-01', cancelled: true });
    const access = await deriveAccess(env, 'acct-1', DAY);
    expect(access.capabilities.has('board')).toBe(false);
    expect(access.invalidBoardGrantId).toBe(await grantId());
  });

  it('refuses a grant whose term was voided', async () => {
    await seedBoardGrant({ scheduledEndDay: '2027-01-01', voided: true });
    const access = await deriveAccess(env, 'acct-1', DAY);
    expect(access.capabilities.has('board')).toBe(false);
    expect(access.invalidBoardGrantId).toBe(await grantId());
  });

  it('does not report a valid grant as invalid', async () => {
    await seedBoardGrant({ scheduledEndDay: '2027-01-01' });
    const access = await deriveAccess(env, 'acct-1', DAY);
    expect(access.invalidBoardGrantId).toBeNull();
  });
});

/**
 * The recording half, decided on #217 (option 1) and implemented in 3b
 * (#218): a live grant failing re-validation writes a DAY-IDEMPOTENT Access
 * Event attributed to the denied caller — but only when `derived` is the
 * SERVING model. The shadow layer computes the same finding under `legacy`
 * and must never write.
 */
describe('recording the re-validation denial', () => {
  beforeEach(async () => {
    sessionUserId = null;
    await getDb(env).delete(cutoverSettings);
  });

  async function setMode(value: 'legacy' | 'derived') {
    const db = getDb(env);
    await db.delete(cutoverSettings);
    await db
      .insert(cutoverSettings)
      .values({ key: 'cutover_mode', value, updatedAt: new Date() });
  }

  const denialRows = async () =>
    getDb(env).all<{
      operation_key: string;
      requested_action: string;
      outcome: string;
      access_grant_id: string;
      actor_account_id: string;
    }>(
      sql`SELECT e.operation_key, a.requested_action, a.outcome, a.access_grant_id, e.actor_account_id
          FROM access_events a JOIN audit_events e ON e.id = a.event_id
          WHERE a.requested_action = 'grant_precondition_revalidation'`,
    );

  it('writes one event per grant per day when derived serves the denial', async () => {
    await seedBoardGrant({ scheduledEndDay: '2026-02-01' });
    await setMode('derived');
    sessionUserId = 'acct-1';

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);
    expect(ctx?.capabilities.has('board')).toBe(false);

    const first = await denialRows();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      requested_action: 'grant_precondition_revalidation',
      outcome: 'denied',
      access_grant_id: await grantId(),
      actor_account_id: 'acct-1',
    });
    expect(first[0].operation_key).toBe(
      `grant-revalidation:${await grantId()}:${DAY}`,
    );

    // The same day writes nothing further — one row per grant per day.
    await getAuthContext(new Request('http://localhost'), env, DAY);
    expect(await denialRows()).toHaveLength(1);

    expect(
      await getDb(env).all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('writes nothing while legacy serves, even with the same invalid grant', async () => {
    await seedBoardGrant({ scheduledEndDay: '2026-02-01' });
    await setMode('legacy');
    sessionUserId = 'acct-1';
    await getAuthContext(new Request('http://localhost'), env, DAY);
    expect(await denialRows()).toHaveLength(0);
  });
});
