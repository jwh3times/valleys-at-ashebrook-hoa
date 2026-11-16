import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALWAYS, type SqlGuard } from '../../src/server/roster/audit';
import { contactProofStatements } from '../../src/server/roster/identity';
import {
  resetTenancyWorld,
  seedAccount,
  seedLinkedAccount,
} from './tenancy-fixtures';

// #600: accepted contact proof has one writer. A credential (a one-time code,
// a Tenancy Invitation) consumes itself in its own primary statement; the
// Person Verification, the Person Link and the `person_verified` Identity
// Event it then records are written here, each only once that credential's
// consumption has landed.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await resetTenancyWorld();
  await env.DATABASE.prepare(
    `INSERT INTO contact_methods (id, party_id, party_kind, channel, value,
       value_normalized, created_at, updated_at)
     VALUES ('cm-sms', 'tenant', 'person', 'sms', '+15555550123',
       '+15555550123', 1, 1)`,
  ).run();
  await seedAccount('acct');
});

/** Stand-ins for the credential's consumed post-state. */
const CONSUMED = ALWAYS;
const NOT_CONSUMED: SqlGuard = { sql: '0', binds: [] };

function record(credentialConsumed: SqlGuard) {
  return contactProofStatements({
    database: env.DATABASE,
    credentialConsumed,
    accountId: 'acct',
    personId: 'tenant',
    channel: 'sms',
    contactMethodId: 'cm-sms',
    reason: 'tenant_invitation',
    operationKey: 'test:person_verified:1',
    nowMs: 1_700_000_000_000,
  });
}

async function rows(table: string, accountId = 'acct') {
  const { results } = await env.DATABASE.prepare(
    `SELECT * FROM ${table} WHERE account_id = ?`,
  )
    .bind(accountId)
    .all<Record<string, unknown>>();
  return results;
}

async function identityEvents() {
  const { results } = await env.DATABASE.prepare(
    `SELECT e.event_kind, e.actor_account_id, e.operation_key, i.reason_code,
            i.person_id, i.target_account_id, i.person_verification_id,
            i.person_link_id
     FROM identity_events i JOIN audit_events e ON e.id = i.event_id`,
  ).all<Record<string, unknown>>();
  return results;
}

describe('recording accepted contact proof', () => {
  it('writes one verification, one link and one person_verified event once the credential is consumed', async () => {
    const { verificationId, linkId, statements } = record(CONSUMED);
    await env.DATABASE.batch(statements);

    expect(await rows('person_verifications')).toEqual([
      expect.objectContaining({
        id: verificationId,
        person_id: 'tenant',
        method: 'otp_sms',
        contact_method_id: 'cm-sms',
        contact_method_party_kind: 'person',
        approver_account_id: null,
        reason: 'automatic_contact_proof',
        verified_at: 1_700_000_000_000,
      }),
    ]);
    expect(await rows('person_links')).toEqual([
      expect.objectContaining({
        id: linkId,
        person_id: 'tenant',
        verification_id: verificationId,
        started_at: 1_700_000_000_000,
        ended_at: null,
      }),
    ]);
    expect(await identityEvents()).toEqual([
      {
        event_kind: 'person_verified',
        actor_account_id: 'acct',
        operation_key: 'test:person_verified:1',
        reason_code: 'tenant_invitation',
        person_id: 'tenant',
        target_account_id: 'acct',
        person_verification_id: verificationId,
        person_link_id: linkId,
      },
    ]);
  });

  it('writes nothing in any of the three tables when the credential was not consumed', async () => {
    await env.DATABASE.batch(record(NOT_CONSUMED).statements);
    expect(await rows('person_verifications')).toEqual([]);
    expect(await rows('person_links')).toEqual([]);
    expect(await identityEvents()).toEqual([]);
  });

  it('errors the whole batch when the Person was linked to another Account meanwhile', async () => {
    await seedLinkedAccount('acct-other', 'tenant');
    // The caller's primary: here, a stand-in write that must roll back too.
    const primary = env.DATABASE.prepare(
      `UPDATE users SET name = 'consumed' WHERE id = 'acct'`,
    );
    await expect(
      env.DATABASE.batch([primary, ...record(CONSUMED).statements]),
    ).rejects.toThrow(/UNIQUE constraint failed: person_links\./);
    expect(await rows('person_verifications')).toEqual([]);
    expect(await rows('person_links')).toEqual([]);
    expect(await identityEvents()).toEqual([]);
    const user = await env.DATABASE.prepare(
      `SELECT name FROM users WHERE id = 'acct'`,
    ).first<{ name: string }>();
    expect(user?.name).toBe('acct');
  });
});
