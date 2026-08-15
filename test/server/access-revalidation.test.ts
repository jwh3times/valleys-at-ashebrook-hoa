import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { deriveAccess } from '../../src/server/authz/derive';
import { resetRoster, seedRoster } from './dual-fixtures';

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
 * The recording half — an Access Event per #200 — is not implemented yet. The
 * `automatic` shape is schema-impossible at a correlation root, but an
 * account-attributed root is legal (the shape #197's last-System-Administrator
 * denial already uses); what remains open is whether attributing the event to
 * the denied caller is right, or whether this belongs in #205's bounded
 * security telemetry. Decision tracked on #217; tests for it land with it.
 */
