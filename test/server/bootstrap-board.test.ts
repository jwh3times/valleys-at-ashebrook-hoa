import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  organizations,
  personVerifications,
  personLinks,
  accessGrants,
  systemAdminBootstrap,
} from '../../src/server/db/roster-schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { pauseNextBatch } from './fixtures';

/**
 * ADR 0022 phase 3c (#219): the rewritten first-System-Administrator
 * bootstrap. Replaces the retired BOARD_EMAIL/PASSWORD sign-up path with
 * linking an already-signed-in account to an already-recorded Person, per
 * #201's amendment. See `src/server/roster/bootstrap.ts` for the guard order
 * and the atomic batch this exercises.
 */

const getSession = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/auth', () => ({
  createAuth: vi.fn(() => ({
    api: { getSession },
  })),
}));

import { handleBootstrapBoard } from '../../src/server/roster/bootstrap';

const SECRET = 'boot-secret-123';

function envWith(overrides: Record<string, unknown> = {}): Env {
  return {
    ...env,
    BOOTSTRAP_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function req(
  secret: string | undefined,
  body?: unknown,
  rawBody?: string,
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (secret !== undefined) headers['x-bootstrap-secret'] = secret;
  return new Request('http://localhost/api/bootstrap/board', {
    method: 'POST',
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

function asSession(accountId: string | null) {
  getSession.mockResolvedValue(accountId ? { user: { id: accountId } } : null);
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const CLEAR = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'identity_events',
  'access_events',
  'system_admin_bootstrap',
  'access_grants',
  'person_links',
  'person_verifications',
  'people',
  'organizations',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  getSession.mockReset();
  for (const table of CLEAR) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  // Consequences before roots — audit_events.causing_event_id is a
  // self-referencing RESTRICT foreign key.
  await db.run(
    sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
  );
  await db.run(sql.raw('DELETE FROM "audit_events"'));
  await db.run(sql.raw('DELETE FROM "cutover_settings"'));
  await db.run(sql.raw('DELETE FROM "users"'));
});

async function seedPerson(id: string, name = `Person ${id}`) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env).insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName: name,
    nameNormalized: name.toLowerCase(),
    updatedAt: now,
  });
}

async function seedOrganization(id: string, name = `Org ${id}`) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'organization', createdAt: now, updatedAt: now });
  await getDb(env).insert(organizations).values({
    partyId: id,
    partyKind: 'organization',
    legalName: name,
    nameNormalized: name.toLowerCase(),
    updatedAt: now,
  });
}

async function seedAccount(id: string, role: string | null = null) {
  const now = new Date();
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      role,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedLink(accountId: string, personId: string) {
  const now = new Date();
  await getDb(env)
    .insert(personVerifications)
    .values({
      id: `ver-${accountId}-${personId}`,
      accountId,
      personId,
      method: 'manual',
      approverAccountId: accountId,
      reason: 'manual_board_decision',
      verifiedAt: now,
    });
  await getDb(env)
    .insert(personLinks)
    .values({
      id: `link-${accountId}-${personId}`,
      accountId,
      personId,
      verificationId: `ver-${accountId}-${personId}`,
      startedAt: now,
    });
}

async function setFreeze(value: 'on' | 'off') {
  const db = getDb(env);
  await db.run(sql.raw('DELETE FROM "cutover_settings"'));
  await db
    .insert(cutoverSettings)
    .values({ key: 'write_freeze', value, updatedAt: new Date() });
}

describe('POST /api/bootstrap/board', () => {
  it('204 links the first System Administrator, writes every row in one batch, then is 410', async () => {
    await seedPerson('person-1');
    await seedAccount('acct-1', 'visitor');
    asSession('acct-1');

    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const db = getDb(env);

    const [verification] = await db.select().from(personVerifications);
    expect(verification).toMatchObject({
      accountId: 'acct-1',
      personId: 'person-1',
      method: 'bootstrap',
      contactMethodId: null,
      approverAccountId: null,
      reason: 'bootstrap_first_administrator',
    });

    const [link] = await db.select().from(personLinks);
    expect(link).toMatchObject({
      accountId: 'acct-1',
      personId: 'person-1',
      verificationId: verification.id,
      endedAt: null,
    });

    const [grant] = await db.select().from(accessGrants);
    expect(grant).toMatchObject({
      accountId: 'acct-1',
      grantType: 'system_admin',
      qualifyingBoardTermId: null,
      grantedByAccountId: 'acct-1',
      grantReason: 'bootstrap',
      endedAt: null,
    });

    const [singleton] = await db.select().from(systemAdminBootstrap);
    expect(singleton).toMatchObject({
      accountId: 'acct-1',
      accessGrantId: grant.id,
    });

    // Write-behind mirror: the caller's role flips from visitor to board.
    const [account] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, 'acct-1'));
    expect(account.role).toBe('board');

    const events = await db.all<{
      event_kind: string;
      family: string;
      correlation_sequence: number;
      actor_kind: string;
      actor_account_id: string | null;
      automatic_cause: string | null;
      operation_key: string | null;
      correlation_id: string;
    }>(
      sql`SELECT event_kind, family, correlation_sequence, actor_kind, actor_account_id, automatic_cause, operation_key, correlation_id FROM audit_events ORDER BY correlation_sequence`,
    );
    expect(events).toHaveLength(2);
    const [root, consequence] = events;
    expect(root).toMatchObject({
      event_kind: 'person_verified',
      family: 'identity',
      correlation_sequence: 0,
      actor_kind: 'bootstrap',
      actor_account_id: 'acct-1',
    });
    expect(root.operation_key).toBeTruthy();
    expect(consequence).toMatchObject({
      event_kind: 'grant_created',
      family: 'access',
      correlation_sequence: 1,
      actor_kind: 'automatic',
      automatic_cause: 'bootstrap',
      operation_key: null,
    });
    expect(consequence.correlation_id).toBe(root.correlation_id);

    const [identityDetail] = await db.all<{
      person_verification_id: string;
      person_link_id: string;
      person_id: string;
      target_account_id: string;
      reason_code: string;
    }>(
      sql`SELECT person_verification_id, person_link_id, person_id, target_account_id, reason_code FROM identity_events`,
    );
    expect(identityDetail).toMatchObject({
      person_verification_id: verification.id,
      person_link_id: link.id,
      person_id: 'person-1',
      target_account_id: 'acct-1',
      reason_code: 'bootstrap_first_administrator',
    });

    const [accessDetail] = await db.all<{
      access_grant_id: string;
      target_account_id: string;
      grant_type: string;
      requested_action: string;
      outcome: string;
    }>(
      sql`SELECT access_grant_id, target_account_id, grant_type, requested_action, outcome FROM access_events`,
    );
    expect(accessDetail).toMatchObject({
      access_grant_id: grant.id,
      target_account_id: 'acct-1',
      grant_type: 'system_admin',
      requested_action: 'bootstrap',
      outcome: 'allowed',
    });

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);

    // Self-disabling: a second call is refused, secret and session included.
    const second = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(second.status).toBe(410);
  });

  it('410 once the singleton has been consumed, even with a valid secret + session + body', async () => {
    await seedPerson('person-1');
    await seedAccount('acct-1');
    await seedAccount('acct-2');
    await getDb(env).insert(accessGrants).values({
      id: 'g-existing',
      accountId: 'acct-2',
      grantType: 'system_admin',
      startedAt: new Date(),
      grantReason: 'bootstrap',
    });
    await getDb(env).insert(systemAdminBootstrap).values({
      consumedAt: new Date(),
      accountId: 'acct-2',
      accessGrantId: 'g-existing',
    });
    asSession('acct-1');

    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(res.status).toBe(410);
  });

  it('403 on a wrong secret', async () => {
    await seedPerson('person-1');
    asSession('acct-1');
    const res = await handleBootstrapBoard(
      envWith(),
      req('wrong', { personId: 'person-1' }),
    );
    expect(res.status).toBe(403);
  });

  it('403 when the secret binding is unset (an unset secret is never open)', async () => {
    await seedPerson('person-1');
    asSession('acct-1');
    const res = await handleBootstrapBoard(
      envWith({ BOOTSTRAP_SECRET: undefined }),
      req('anything', { personId: 'person-1' }),
    );
    expect(res.status).toBe(403);
  });

  it('403 when the secret header is missing', async () => {
    await seedPerson('person-1');
    asSession('acct-1');
    const res = await handleBootstrapBoard(
      envWith(),
      req(undefined, { personId: 'person-1' }),
    );
    expect(res.status).toBe(403);
  });

  it('401 with a valid secret but no session', async () => {
    await seedPerson('person-1');
    asSession(null);
    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(res.status).toBe(401);
  });

  it('400 on a malformed JSON body', async () => {
    await seedPerson('person-1');
    asSession('acct-1');
    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, undefined, '{not json'),
    );
    expect(res.status).toBe(400);
  });

  it('400 when personId is missing', async () => {
    asSession('acct-1');
    const res = await handleBootstrapBoard(envWith(), req(SECRET, {}));
    expect(res.status).toBe(400);
  });

  it('404 for an unknown personId', async () => {
    asSession('acct-1');
    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'no-such-person' }),
    );
    expect(res.status).toBe(404);
  });

  it('409 when personId names an organization, not a Person', async () => {
    await seedOrganization('org-1');
    asSession('acct-1');
    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'org-1' }),
    );
    expect(res.status).toBe(409);
  });

  it('409 when the Person is already linked to a different account', async () => {
    await seedPerson('person-1');
    await seedAccount('acct-2');
    await seedLink('acct-2', 'person-1');
    asSession('acct-1');

    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(res.status).toBe(409);
    expect(await getDb(env).select().from(personVerifications)).toHaveLength(1);
  });

  it('409 when the caller account is already linked to a different Person', async () => {
    await seedPerson('person-1');
    await seedPerson('person-2');
    await seedAccount('acct-1');
    await seedLink('acct-1', 'person-2');
    asSession('acct-1');

    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(res.status).toBe(409);
    expect(await getDb(env).select().from(personVerifications)).toHaveLength(1);
  });

  it('succeeds while the operator write freeze is ON — this route is one of the two exemptions', async () => {
    await seedPerson('person-1');
    await seedAccount('acct-1');
    asSession('acct-1');
    await setFreeze('on');

    const res = await handleBootstrapBoard(
      envWith(),
      req(SECRET, { personId: 'person-1' }),
    );
    expect(res.status).toBe(204);
  });

  it('a race between two concurrent bootstraps lets exactly one land; the loser contributes zero rows', async () => {
    await seedPerson('person-a');
    await seedPerson('person-b');
    await seedAccount('acct-a', 'visitor');
    await seedAccount('acct-b', 'visitor');

    const pause = pauseNextBatch();
    try {
      asSession('acct-a');
      const first = handleBootstrapBoard(
        envWith(),
        req(SECRET, { personId: 'person-a' }),
      );
      await pause.reached;

      // B races in and wins: its batch is not paused (the mock only pauses
      // once), so it commits — consuming the singleton — before A resumes.
      asSession('acct-b');
      const second = await handleBootstrapBoard(
        envWith(),
        req(SECRET, { personId: 'person-b' }),
      );
      expect(second.status).toBe(204);

      pause.release();
      // A's own chain-guarded primary now finds the singleton already
      // consumed: it inserts NOTHING, not even its own verification row.
      const firstRes = await first;
      expect(firstRes.status).toBe(410);
    } finally {
      pause.restore();
    }

    const db = getDb(env);
    const verifications = await db.select().from(personVerifications);
    expect(verifications).toHaveLength(1);
    expect(verifications[0].accountId).toBe('acct-b');
    const links = await db.select().from(personLinks);
    expect(links).toHaveLength(1);
    expect(links[0].accountId).toBe('acct-b');
    const grants = await db.select().from(accessGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0].accountId).toBe('acct-b');
    const singletons = await db.select().from(systemAdminBootstrap);
    expect(singletons).toHaveLength(1);
    expect(singletons[0].accountId).toBe('acct-b');

    // A's own role is untouched — the write-behind mirror never ran for it.
    const [accountA] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, 'acct-a'));
    expect(accountA.role).toBe('visitor');
    const [accountB] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, 'acct-b'));
    expect(accountB.role).toBe('board');

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });
});
