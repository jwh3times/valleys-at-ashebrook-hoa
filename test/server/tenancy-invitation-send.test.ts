import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// #294 slice 4 (ADR 0028, spec decision 4): approving a request sends the
// tenant a single-use invitation link, and the board can re-invite. The link
// carries a 256-bit token; the table keeps only its HMAC. A new invitation
// supersedes the Tenancy's earlier unconsumed ones, and sends are limited to
// three a day per Tenancy.

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('board', 'board', []),
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '../../src/pages/api/admin/tenancies';
import { sendEmail, sendSms } from '../../src/server/auth/senders';
import { associationDateIso } from '../../src/lib/format';
import { getDb } from '../../src/server/db/client';
import { callerContext } from './caller-context';
import { pauseNextBatch, req } from './fixtures';
import {
  resetTenancyWorld,
  seedLinkedAccount,
  seedTenancy,
} from './tenancy-fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const URL = 'http://localhost/api/admin/tenancies';
const today = associationDateIso();
const DAY_MS = 86_400_000;
const LINK = /^http:\/\/localhost\/tenant-invite\?token=([A-Za-z0-9_-]{43})$/m;

function monthsOut(months: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function setGates(officialMode: boolean, tenantAccessEnabled: boolean) {
  await getDb(env).run(sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('site', ${JSON.stringify({ officialMode, tenantAccessEnabled })}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
}

async function seedRequest(
  id: string,
  overrides: Record<string, string | number | null> = {},
) {
  const row: Record<string, string | number | null> = {
    id,
    lot_id: 'lot',
    requested_by_account_id: 'acct-owner',
    requested_by_person_id: 'owner',
    basis_ownership_id: 'owner-lot-own',
    kind: 'new',
    tenant_name: 'Tess Tenant',
    channel: 'email',
    contact_value: 'Tess@Example.test',
    contact_normalized: 'tess@example.test',
    scheduled_end_day: monthsOut(12),
    created_at: 1,
    ...overrides,
  };
  const names = Object.keys(row);
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_requests (${names.join(', ')})
     VALUES (${names.map(() => '?').join(', ')})`,
  )
    .bind(...names.map((n) => row[n]))
    .run();
}

async function seedContact(
  id: string,
  partyId: string,
  channel: 'email' | 'sms',
  value: string,
  extra: { voided?: boolean } = {},
) {
  await env.DATABASE.prepare(
    `INSERT INTO contact_methods (id, party_id, party_kind, channel, value,
       value_normalized, voided_at, created_at, updated_at)
     VALUES (?, ?, 'person', ?, ?, ?, ?, 1, 1)`,
  )
    .bind(
      id,
      partyId,
      channel,
      value,
      value.toLowerCase(),
      extra.voided ? 1 : null,
    )
    .run();
}

/** An invitation already on file, as an earlier send left it. */
async function seedInvitation(
  id: string,
  tenancyId: string,
  contactMethodId: string,
  createdAt = Date.now() - DAY_MS,
) {
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_invitations (id, tenancy_id, contact_method_id, channel,
       token_hash, expires_at, created_at)
     VALUES (?, ?, ?, 'email', ?, ?, ?)`,
  )
    .bind(
      id,
      tenancyId,
      contactMethodId,
      `hash-${id}`,
      createdAt + 14 * DAY_MS,
      createdAt,
    )
    .run();
}

async function act(body: Record<string, unknown>): Promise<Response> {
  return POST(req(URL, 'POST', body));
}

async function invitations(tenancyId: string) {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, contact_method_id, channel, token_hash, expires_at, created_at,
            consumed_at, superseded_at
     FROM tenancy_invitations WHERE tenancy_id = ? ORDER BY created_at, id`,
  )
    .bind(tenancyId)
    .all<{
      id: string;
      contact_method_id: string;
      channel: string;
      token_hash: string;
      expires_at: number;
      created_at: number;
      consumed_at: number | null;
      superseded_at: number | null;
    }>();
  return results;
}

/** The one message sent, and the token its link carries. */
function sentEmail(): { to: string; text: string; token: string } {
  expect(sendEmail).toHaveBeenCalledTimes(1);
  const [, to, , text] = vi.mocked(sendEmail).mock.calls[0];
  const token = LINK.exec(text)?.[1];
  expect(token, `no invitation link in: ${text}`).toBeDefined();
  return { to, text, token: token! };
}

async function clearSendLimits() {
  const { keys } = await env.KV.list({ prefix: 'tenant-invite:' });
  for (const key of keys) await env.KV.delete(key.name);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
  vi.mocked(sendSms).mockResolvedValue(undefined);
  await clearSendLimits();
  await resetTenancyWorld();
  await env.DATABASE.prepare('DELETE FROM settings').run();
  await setGates(true, true);
});

describe('approving a new request', () => {
  it('emails the requested contact a link to /tenant-invite, storing only its HMAC for 14 days', async () => {
    await seedRequest('req');
    const before = Date.now();
    const res = await act({ action: 'approve', requestId: 'req' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tenancyId: string;
      personId: string;
      invitation: string;
    };
    expect(body.invitation).toBe('sent');

    const { to, token } = sentEmail();
    expect(to).toBe('Tess@Example.test');
    const [row] = await invitations(body.tenancyId);
    const contact = await env.DATABASE.prepare(
      `SELECT id FROM contact_methods WHERE party_id = ?`,
    )
      .bind(body.personId)
      .first<{ id: string }>();
    expect(row).toMatchObject({
      contact_method_id: contact!.id,
      channel: 'email',
      consumed_at: null,
      superseded_at: null,
    });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
    expect(row.expires_at - row.created_at).toBe(14 * DAY_MS);
    expect(row.created_at).toBeGreaterThanOrEqual(before);
  });

  it('texts the link when the request asked for SMS', async () => {
    await seedRequest('req', {
      channel: 'sms',
      contact_value: '+15555550123',
      contact_normalized: '+15555550123',
    });
    const res = await act({ action: 'approve', requestId: 'req' });
    expect(res.status).toBe(201);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [, to, text] = vi.mocked(sendSms).mock.calls[0];
    expect(to).toBe('+15555550123');
    expect(text).toMatch(LINK);
  });

  it("sends to the named Person's existing Contact Method when they already hold the contact", async () => {
    await seedContact('cm-held', 'tenant', 'email', 'tess@example.test');
    await seedRequest('req');
    const res = await act({
      action: 'approve',
      requestId: 'req',
      personId: 'tenant',
    });
    const { tenancyId } = (await res.json()) as { tenancyId: string };
    expect((await invitations(tenancyId))[0].contact_method_id).toBe('cm-held');
    expect(sentEmail().to).toBe('tess@example.test');
  });

  it('keeps the approval but leaves no usable invitation when the send fails', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('provider down'));
    await seedRequest('req');
    const res = await act({ action: 'approve', requestId: 'req' });
    expect(res.status).toBe(201);
    const { tenancyId, invitation } = (await res.json()) as {
      tenancyId: string;
      invitation: string;
    };
    expect(invitation).toBe('send_failed');
    expect(await invitations(tenancyId)).toEqual([]);
  });
});

describe('approving a renewal', () => {
  beforeEach(async () => {
    await seedContact('cm-tess', 'tenant', 'email', 'tess@example.test');
    await seedTenancy('old', { scheduledEndDay: monthsOut(1) });
    await seedInvitation('inv-old', 'old', 'cm-tess');
    await seedRequest('ren', {
      kind: 'renewal',
      renews_tenancy_id: 'old',
      tenant_name: null,
      channel: null,
      contact_value: null,
      contact_normalized: null,
      scheduled_end_day: monthsOut(12),
    });
  });

  it("invites a tenant who never claimed, at their latest invitation's contact", async () => {
    const res = await act({ action: 'approve', requestId: 'ren' });
    const { tenancyId, invitation } = (await res.json()) as {
      tenancyId: string;
      invitation: string;
    };
    expect(invitation).toBe('sent');
    expect(sentEmail().to).toBe('tess@example.test');
    expect((await invitations(tenancyId))[0].contact_method_id).toBe('cm-tess');
  });

  it('sends nothing to a tenant who has already claimed', async () => {
    await seedLinkedAccount('acct-tess', 'tenant');
    const res = await act({ action: 'approve', requestId: 'ren' });
    const { tenancyId, invitation } = (await res.json()) as {
      tenancyId: string;
      invitation: string;
    };
    expect(invitation).toBe('none');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await invitations(tenancyId)).toEqual([]);
  });
});

describe('the board re-invites', () => {
  beforeEach(async () => {
    await seedContact('cm-tess', 'tenant', 'email', 'tess@example.test');
    await seedTenancy('ten');
    await seedInvitation('inv-1', 'ten', 'cm-tess');
  });

  it("sends a fresh link to the latest invitation's contact and supersedes the earlier one", async () => {
    const res = await act({ action: 'reinvite', tenancyId: 'ten' });
    expect(res.status).toBe(204);
    expect(sentEmail().to).toBe('tess@example.test');
    const rows = await invitations('ten');
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('inv-1');
    expect(rows[0].superseded_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      contact_method_id: 'cm-tess',
      superseded_at: null,
      consumed_at: null,
    });
  });

  it('does not supersede the earlier link when the send fails', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('provider down'));
    const res = await act({ action: 'reinvite', tenancyId: 'ten' });
    expect(res.status).toBe(502);
    expect(await invitations('ten')).toMatchObject([
      { id: 'inv-1', superseded_at: null },
    ]);
  });

  it('allows three sends a day per Tenancy', async () => {
    for (let i = 0; i < 3; i++)
      expect((await act({ action: 'reinvite', tenancyId: 'ten' })).status).toBe(
        204,
      );
    const res = await act({ action: 'reinvite', tenancyId: 'ten' });
    expect(res.status).toBe(429);
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it('refuses once the tenant has claimed', async () => {
    await seedLinkedAccount('acct-tess', 'tenant');
    const res = await act({ action: 'reinvite', tenancyId: 'ten' });
    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses for an ended or voided Tenancy', async () => {
    await seedTenancy('ended', { actualEndDay: today });
    await seedInvitation('inv-e', 'ended', 'cm-tess');
    await seedTenancy('voided', { voided: true });
    await seedInvitation('inv-v', 'voided', 'cm-tess');
    for (const tenancyId of ['ended', 'voided'])
      expect((await act({ action: 'reinvite', tenancyId })).status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses when the contact it would reuse is no longer on file', async () => {
    await env.DATABASE.prepare(
      `UPDATE contact_methods SET voided_at = 1 WHERE id = 'cm-tess'`,
    ).run();
    const res = await act({ action: 'reinvite', tenancyId: 'ten' });
    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('re-checks the gates, the claim, the Tenancy and the contact inside the write', async () => {
    const races: Array<() => Promise<unknown>> = [
      () => setGates(true, false),
      () => seedLinkedAccount('acct-tess', 'tenant'),
      () =>
        env.DATABASE.prepare(
          `UPDATE tenancies SET voided_at = 1 WHERE id = 'ten'`,
        ).run(),
      () =>
        env.DATABASE.prepare(
          `UPDATE contact_methods SET voided_at = 1 WHERE id = 'cm-tess'`,
        ).run(),
    ];
    for (const race of races) {
      await resetTenancyWorld();
      await setGates(true, true);
      await seedContact('cm-tess', 'tenant', 'email', 'tess@example.test');
      await seedTenancy('ten');
      await seedInvitation('inv-1', 'ten', 'cm-tess');
      const paused = pauseNextBatch();
      const pending = act({ action: 'reinvite', tenancyId: 'ten' });
      await paused.reached;
      await race();
      paused.release();
      const res = await pending;
      paused.restore();
      expect(res.status).toBe(409);
      expect(await invitations('ten')).toMatchObject([
        { id: 'inv-1', superseded_at: null },
      ]);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown Tenancy, or while either gate is off', async () => {
    expect((await act({ action: 'reinvite', tenancyId: 'nope' })).status).toBe(
      404,
    );
    await setGates(true, false);
    expect((await act({ action: 'reinvite', tenancyId: 'ten' })).status).toBe(
      404,
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
