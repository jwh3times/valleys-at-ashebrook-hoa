import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { POST } from '../../src/pages/api/verify/tenant-claim';
import { associationDateIso } from '../../src/lib/format';
import { deriveAccess } from '../../src/server/authz/derive';
import type { AuthContext } from '../../src/server/authz/guards';
import { getDb } from '../../src/server/db/client';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../../src/server/roster/tenancy-invitation';
import { pauseNextBatch } from './fixtures';
import {
  resetTenancyWorld,
  seedAccount,
  seedLinkedAccount,
  seedTenancy,
} from './tenancy-fixtures';

// #294 slice 4 (ADR 0028, spec decision 4): a tenant follows the invitation
// link and claims, from their own Account. One batch consumes the invitation,
// records a contact-proof Person Verification, links the Account to the
// tenant Person and records the Identity Event; any re-check that fails
// inside it writes nothing.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const URL = 'http://localhost/api/verify/tenant-claim';
const today = associationDateIso();
const DAY_MS = 86_400_000;

async function setGates(officialMode: boolean, tenantAccessEnabled: boolean) {
  await getDb(env).run(sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('site', ${JSON.stringify({ officialMode, tenantAccessEnabled })}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
}

async function seedContact(
  id: string,
  channel: 'email' | 'sms',
  value: string,
) {
  await env.DATABASE.prepare(
    `INSERT INTO contact_methods (id, party_id, party_kind, channel, value,
       value_normalized, created_at, updated_at)
     VALUES (?, 'tenant', 'person', ?, ?, ?, 1, 1)`,
  )
    .bind(id, channel, value, value.toLowerCase())
    .run();
}

/** An invitation for `tenancyId`, returning the token its link carries. */
async function seedInvitation(
  id: string,
  overrides: {
    tenancyId?: string;
    contactMethodId?: string;
    channel?: 'email' | 'sms';
    expiresAt?: number;
    consumed?: boolean;
    superseded?: boolean;
  } = {},
): Promise<string> {
  const token = generateInvitationToken();
  const createdAt = Date.now() - DAY_MS;
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_invitations (id, tenancy_id, contact_method_id,
       channel, token_hash, expires_at, consumed_at, consumed_by_account_id,
       superseded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      overrides.tenancyId ?? 'ten',
      overrides.contactMethodId ?? 'cm-email',
      overrides.channel ?? 'email',
      await hashInvitationToken(token, env.BETTER_AUTH_SECRET),
      overrides.expiresAt ?? createdAt + 14 * DAY_MS,
      overrides.consumed ? createdAt + 1 : null,
      overrides.consumed ? 'acct-earlier' : null,
      overrides.superseded ? createdAt + 1 : null,
      createdAt,
    )
    .run();
  return token;
}

async function caller(accountId: string): Promise<AuthContext> {
  return deriveAccess(env, accountId, today);
}

async function claim(
  ctx: AuthContext | null,
  body: Record<string, unknown>,
): Promise<Response> {
  return POST({
    request: new Request(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify(body),
    }),
    locals: ctx ? { authContext: ctx } : {},
  } as never);
}

async function rows(table: string) {
  return (await env.DATABASE.prepare(`SELECT * FROM ${table}`).all()).results;
}

async function invitation(id: string) {
  return env.DATABASE.prepare(
    `SELECT consumed_at, consumed_by_account_id, superseded_at
     FROM tenancy_invitations WHERE id = ?`,
  )
    .bind(id)
    .first<{
      consumed_at: number | null;
      consumed_by_account_id: string | null;
      superseded_at: number | null;
    }>();
}

async function clearClaimLimits() {
  const { keys } = await env.KV.list({ prefix: 'tenant-claim:' });
  for (const key of keys) await env.KV.delete(key.name);
}

beforeEach(async () => {
  await clearClaimLimits();
  await resetTenancyWorld();
  await getDb(env).delete(cutoverSettings);
  await env.DATABASE.prepare('DELETE FROM settings').run();
  await setGates(true, true);
  await seedTenancy('ten');
  await seedContact('cm-email', 'email', 'tess@example.test');
  await seedContact('cm-sms', 'sms', '+15555550123');
  await seedAccount('acct-tess');
});

describe('a claim', () => {
  it('links the Account to the tenant by contact proof, so the Tenancy applies at once', async () => {
    const token = await seedInvitation('inv');
    const res = await claim(await caller('acct-tess'), { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [verification] = (await rows('person_verifications')).filter(
      (r) => r.account_id === 'acct-tess',
    );
    expect(verification).toMatchObject({
      person_id: 'tenant',
      method: 'otp_email',
      contact_method_id: 'cm-email',
      contact_method_party_kind: 'person',
      approver_account_id: null,
      reason: 'automatic_contact_proof',
    });
    const [link] = (await rows('person_links')).filter(
      (r) => r.account_id === 'acct-tess',
    );
    expect(link).toMatchObject({
      person_id: 'tenant',
      verification_id: verification.id,
      ended_at: null,
    });
    expect(await invitation('inv')).toMatchObject({
      consumed_by_account_id: 'acct-tess',
    });
    expect((await invitation('inv'))!.consumed_at).not.toBeNull();

    const tess = await caller('acct-tess');
    expect(tess.capabilities.has('tenant')).toBe(true);
    expect(tess.contentTier).toBe('visitor');
  });

  it('records a person_verified Identity Event with the tenant_invitation reason', async () => {
    const token = await seedInvitation('inv');
    await claim(await caller('acct-tess'), { token });
    const identity = await env.DATABASE.prepare(
      `SELECT e.family, e.event_kind, e.actor_account_id, e.operation_key,
              i.reason_code, i.person_id, i.target_account_id,
              i.person_verification_id, i.person_link_id
       FROM identity_events i JOIN audit_events e ON e.id = i.event_id`,
    ).all<Record<string, string>>();
    expect(identity.results).toHaveLength(1);
    const [event] = identity.results;
    expect(event).toMatchObject({
      family: 'identity',
      event_kind: 'person_verified',
      actor_account_id: 'acct-tess',
      reason_code: 'tenant_invitation',
      person_id: 'tenant',
      target_account_id: 'acct-tess',
    });
    expect(event.operation_key).toMatch(/^tenant-claim:person_verified:/);
    const [link] = (await rows('person_links')).filter(
      (r) => r.account_id === 'acct-tess',
    );
    expect(event.person_link_id).toBe(link.id);
    expect(event.person_verification_id).toBe(link.verification_id);
    expect(await rows('audit_integrity_violations_v')).toEqual([]);
  });

  it('records an SMS invitation as SMS contact proof', async () => {
    const token = await seedInvitation('inv', {
      contactMethodId: 'cm-sms',
      channel: 'sms',
    });
    expect((await claim(await caller('acct-tess'), { token })).status).toBe(
      200,
    );
    const [verification] = (await rows('person_verifications')).filter(
      (r) => r.account_id === 'acct-tess',
    );
    expect(verification).toMatchObject({
      method: 'otp_sms',
      contact_method_id: 'cm-sms',
    });
  });

  it('consumes the invitation and changes nothing else for an Account already linked to the tenant', async () => {
    await seedLinkedAccount('acct-linked', 'tenant');
    const token = await seedInvitation('inv');
    const before = (await rows('person_verifications')).length;
    const res = await claim(await caller('acct-linked'), { token });
    expect(res.status).toBe(200);
    expect(await invitation('inv')).toMatchObject({
      consumed_by_account_id: 'acct-linked',
    });
    expect(await rows('person_verifications')).toHaveLength(before);
    expect(await rows('identity_events')).toEqual([]);
  });
});

describe('a refused claim writes nothing', () => {
  async function unchanged(invitationId: string) {
    expect(
      (await rows('person_links')).filter((r) => r.account_id === 'acct-tess'),
    ).toEqual([]);
    expect(await rows('identity_events')).toEqual([]);
    expect(await invitation(invitationId)).toMatchObject({
      consumed_at: null,
    });
  }

  it('answers 409 linked-elsewhere to an Account linked to someone else', async () => {
    await seedLinkedAccount('acct-other', 'owner');
    const token = await seedInvitation('inv');
    const res = await claim(await caller('acct-other'), { token });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'linked-elsewhere' });
    expect(await invitation('inv')).toMatchObject({ consumed_at: null });
  });

  it('answers 409 person-linked when the tenant is linked to another Account', async () => {
    await seedLinkedAccount('acct-first', 'tenant');
    const token = await seedInvitation('inv');
    const res = await claim(await caller('acct-tess'), { token });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'person-linked' });
    await unchanged('inv');
  });

  it('answers 400 invalid-invitation, the same way, to an unknown, expired, used or superseded token', async () => {
    const tokens = {
      unknown: generateInvitationToken(),
      malformed: 'not-a-token',
      expired: await seedInvitation('expired', { expiresAt: Date.now() - 1 }),
      used: await seedInvitation('used', { consumed: true }),
      superseded: await seedInvitation('superseded', { superseded: true }),
    };
    const bodies = new Set<string>();
    for (const token of Object.values(tokens)) {
      await clearClaimLimits();
      const res = await claim(await caller('acct-tess'), { token });
      expect(res.status).toBe(400);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0])).toMatchObject({
      reason: 'invalid-invitation',
    });
    expect(await rows('identity_events')).toEqual([]);
  });

  it('answers 409 tenancy-ended once the Tenancy has ended or been voided', async () => {
    await seedTenancy('ended', {
      startDay: '2025-06-01',
      scheduledEndDay: '2099-01-01',
      actualEndDay: today,
    });
    await seedTenancy('voided', { voided: true });
    for (const tenancyId of ['ended', 'voided']) {
      const token = await seedInvitation(`inv-${tenancyId}`, { tenancyId });
      const res = await claim(await caller('acct-tess'), { token });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'tenancy-ended' });
      await unchanged(`inv-${tenancyId}`);
    }
  });
});

describe('the guards', () => {
  it('answers 503 while the site is frozen, before anything else', async () => {
    await getDb(env)
      .insert(cutoverSettings)
      .values({ key: 'write_freeze', value: 'on', updatedAt: new Date() });
    const token = await seedInvitation('inv');
    expect((await claim(null, { token })).status).toBe(503);
    expect((await claim(await caller('acct-tess'), { token })).status).toBe(
      503,
    );
  });

  it('answers 401 to a signed-out caller', async () => {
    const token = await seedInvitation('inv');
    expect((await claim(null, { token })).status).toBe(401);
  });

  it('answers 404 while either gate is off', async () => {
    const token = await seedInvitation('inv');
    for (const [official, tenant] of [
      [false, true],
      [true, false],
    ] as const) {
      await setGates(official, tenant);
      expect((await claim(await caller('acct-tess'), { token })).status).toBe(
        404,
      );
    }
    expect(await invitation('inv')).toMatchObject({ consumed_at: null });
  });

  it('spends no attempt while the gates are off', async () => {
    const token = await seedInvitation('inv');
    await setGates(true, false);
    for (let i = 0; i < 6; i++)
      expect((await claim(await caller('acct-tess'), { token })).status).toBe(
        404,
      );
    await setGates(true, true);
    expect((await claim(await caller('acct-tess'), { token })).status).toBe(
      200,
    );
  });

  it('allows an Account five claim attempts a day, then 429 even with a good token', async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (
          await claim(await caller('acct-tess'), {
            token: generateInvitationToken(),
          })
        ).status,
      ).toBe(400);
    const token = await seedInvitation('inv');
    expect((await claim(await caller('acct-tess'), { token })).status).toBe(
      429,
    );
    expect(await invitation('inv')).toMatchObject({ consumed_at: null });
  });
});

describe('the batch re-checks', () => {
  async function raced(race: () => Promise<unknown>): Promise<Response> {
    const token = await seedInvitation('inv');
    const ctx = await caller('acct-tess');
    const paused = pauseNextBatch();
    try {
      const pending = claim(ctx, { token });
      await paused.reached;
      await race();
      paused.release();
      return await pending;
    } finally {
      paused.restore();
    }
  }

  async function nothingWritten() {
    expect(
      (await rows('person_links')).filter((r) => r.account_id === 'acct-tess'),
    ).toEqual([]);
    expect(
      (await rows('person_verifications')).filter(
        (r) => r.account_id === 'acct-tess',
      ),
    ).toEqual([]);
    expect(await rows('identity_events')).toEqual([]);
  }

  it('that the invitation is still unused', async () => {
    // Another Account's claim consumed it first. (A superseding race would
    // prove nothing: the table's single-end CHECK refuses it on its own.)
    const res = await raced(() =>
      env.DATABASE.prepare(
        `UPDATE tenancy_invitations
         SET consumed_at = 1, consumed_by_account_id = 'acct-first'
         WHERE id = 'inv'`,
      ).run(),
    );
    expect(res.status).toBe(400);
    await nothingWritten();
  });

  it('that the Tenancy is still current', async () => {
    const res = await raced(() =>
      env.DATABASE.prepare(
        `UPDATE tenancies SET voided_at = 1 WHERE id = 'ten'`,
      ).run(),
    );
    expect(res.status).toBe(409);
    await nothingWritten();
    expect(await invitation('inv')).toMatchObject({ consumed_at: null });
  });

  it('that both gates are still on', async () => {
    const res = await raced(() => setGates(true, false));
    expect(res.status).toBe(404);
    await nothingWritten();
    expect(await invitation('inv')).toMatchObject({ consumed_at: null });
  });

  it('that no other Account linked the tenant meanwhile', async () => {
    const res = await raced(() => seedLinkedAccount('acct-first', 'tenant'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'person-linked' });
    await nothingWritten();
    expect(await invitation('inv')).toMatchObject({ consumed_at: null });
  });

  it('lets a database fault surface as an error, never as an invalid invitation', async () => {
    const token = await seedInvitation('inv');
    const ctx = await caller('acct-tess');
    const spy = vi
      .spyOn(env.DATABASE, 'batch')
      .mockRejectedValueOnce(new Error('D1_ERROR: storage unavailable'));
    try {
      await expect(claim(ctx, { token })).rejects.toThrow(
        /storage unavailable/,
      );
    } finally {
      spy.mockRestore();
    }
    await nothingWritten();
  });
});
