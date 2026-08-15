import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { people, contactMethods } from '../../src/server/db/roster-schema';
import {
  auditEvents,
  rosterRedactions,
  auditSensitiveFieldChanges,
  redactionTasks,
} from '../../src/server/db/audit-schema';
import type { AuthContext, Capability } from '../../src/server/authz/guards';
import { legacyAuthContext } from '../../src/server/authz/context';
import { GET, POST } from '../../src/pages/api/admin/redactions';

/**
 * redactions.ts is one of the three System-Administrator-only compliance
 * surfaces (#205, #217). Unlike the *-board.test.ts idiom, callers here are
 * built by hand and injected via `locals.authContext` — this route's whole
 * point is that plain `board` is NOT enough, so the caller shape itself is
 * what each test is exercising.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const url = 'http://localhost/api/admin/redactions';

const TABLES_TO_CLEAR = [
  'redaction_tasks',
  'audit_sensitive_field_changes',
  'audit_scalar_changes',
  'roster_redactions',
  'audit_events',
  'contact_methods',
  'people',
  'parties',
  'users',
];

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

async function seedPerson(id: string, fullName: string) {
  await env.DATABASE.prepare(
    `INSERT INTO parties (id, kind, created_at, updated_at) VALUES (?, 'person', 1, 1)`,
  )
    .bind(id)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
     VALUES (?, 'person', ?, ?, 1)`,
  )
    .bind(id, fullName, fullName.toLowerCase())
    .run();
}

async function seedContactMethod(
  id: string,
  partyId: string,
  channel: 'email' | 'sms',
  value: string,
) {
  await env.DATABASE.prepare(
    `INSERT INTO contact_methods (id, party_id, channel, value, value_normalized, is_preferred, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1)`,
  )
    .bind(id, partyId, channel, value, value.toLowerCase())
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

function req(method: string, body: unknown, ctx: AuthContext | null) {
  return {
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never;
}

describe('redactions admin route — redactPersonName', () => {
  it('nulls the name, stamps the marker, and records a complete, leak-free ledger trail', async () => {
    await seedAccount('sa');
    await seedPerson('per-1', 'Jane Q. Resident');

    const res = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'per-1',
          authorityKind: 'legal_requirement',
          authorityReference: 'GDPR Art. 17',
          reason: 'gdpr_erasure',
        },
        systemAdminContext(),
      ),
    );
    expect(res.status).toBe(204);

    const [person] = await getDb(env)
      .select()
      .from(people)
      .where(eq(people.partyId, 'per-1'));
    expect(person.fullName).toBeNull();
    expect(person.nameNormalized).toBeNull();
    expect(person.nameRedactedAt).not.toBeNull();

    const events = await getDb(env).select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0].family).toBe('roster_redaction');
    expect(events[0].eventKind).toBe('value_redacted');

    const redactions = await getDb(env)
      .select()
      .from(rosterRedactions)
      .where(eq(rosterRedactions.eventId, events[0].id));
    expect(redactions).toHaveLength(1);
    expect(redactions[0].targetPersonId).toBe('per-1');
    expect(redactions[0].fieldCategory).toBe('person_name');

    const sensitive = await getDb(env)
      .select()
      .from(auditSensitiveFieldChanges)
      .where(eq(auditSensitiveFieldChanges.eventId, events[0].id));
    expect(sensitive).toHaveLength(1);
    expect(sensitive[0].fieldCategory).toBe('person_name');

    // Load-bearing: the redaction_incomplete branch of the integrity view
    // fires when a roster_redaction event has no cleanup task. Without the
    // task row this insert is missing, the view below would NOT be empty.
    const tasks = await getDb(env)
      .select()
      .from(redactionTasks)
      .where(eq(redactionTasks.redactionEventId, events[0].id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].targetKind).toBe('pseudonymizer_catalog');

    const violations = await getDb(env).all(
      sql`SELECT * FROM audit_integrity_violations_v`,
    );
    expect(violations).toEqual([]);

    // The erased value must never enter any audit table, in any form —
    // search the two tables capable of carrying arbitrary text.
    const scalarLeak = await getDb(env).all(
      sql`SELECT 1 FROM audit_scalar_changes WHERE old_text LIKE ${'%Jane Q. Resident%'} OR new_text LIKE ${'%Jane Q. Resident%'}`,
    );
    expect(scalarLeak).toEqual([]);
    const rosterChangeLeak = await getDb(env).all(
      sql`SELECT 1 FROM roster_changes WHERE external_reference LIKE ${'%Jane Q. Resident%'}`,
    );
    expect(rosterChangeLeak).toEqual([]);

    const again = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'per-1',
          authorityKind: 'legal_requirement',
          authorityReference: 'GDPR Art. 17',
          reason: 'gdpr_erasure',
        },
        systemAdminContext(),
      ),
    );
    expect(again.status).toBe(409);
    expect(await again.text()).toBe('Name already redacted');
    // Still exactly one event — the rejected retry wrote nothing.
    expect(await getDb(env).select().from(auditEvents)).toHaveLength(1);
  });

  it('returns 404 for an unknown person', async () => {
    await seedAccount('sa');
    const res = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'nope',
          authorityKind: 'legal_requirement',
          authorityReference: 'x',
          reason: 'x',
        },
        systemAdminContext(),
      ),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a missing/oversize authority', async () => {
    await seedAccount('sa');
    await seedPerson('per-2', 'Someone');

    const badKind = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'per-2',
          authorityKind: 'because',
          authorityReference: 'x',
          reason: 'x',
        },
        systemAdminContext(),
      ),
    );
    expect(badKind.status).toBe(400);

    const overLongReference = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'per-2',
          authorityKind: 'legal_requirement',
          authorityReference: 'x'.repeat(301),
          reason: 'x',
        },
        systemAdminContext(),
      ),
    );
    expect(overLongReference.status).toBe(400);

    const overLongReason = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'per-2',
          authorityKind: 'legal_requirement',
          authorityReference: 'x',
          reason: 'x'.repeat(121),
        },
        systemAdminContext(),
      ),
    );
    expect(overLongReason.status).toBe(400);
  });
});

describe('redactions admin route — redactContactMethod', () => {
  it('nulls value and normalized together, categorized by channel', async () => {
    await seedAccount('sa');
    await seedPerson('per-3', 'Contact Person');
    await seedContactMethod('cm-email-1', 'per-3', 'email', 'resident@example.com');
    await seedContactMethod('cm-sms-1', 'per-3', 'sms', '+15550001111');

    const emailRes = await POST(
      req(
        'POST',
        {
          action: 'redactContactMethod',
          contactMethodId: 'cm-email-1',
          authorityKind: 'binding_policy',
          authorityReference: 'Board Policy 4',
          reason: 'resident_request',
        },
        systemAdminContext(),
      ),
    );
    expect(emailRes.status).toBe(204);
    const [emailRow] = await getDb(env)
      .select()
      .from(contactMethods)
      .where(eq(contactMethods.id, 'cm-email-1'));
    expect(emailRow.value).toBeNull();
    expect(emailRow.valueNormalized).toBeNull();
    expect(emailRow.redactedAt).not.toBeNull();

    const [emailEvent] = await getDb(env).select().from(auditEvents);
    const [emailDetail] = await getDb(env)
      .select()
      .from(rosterRedactions)
      .where(eq(rosterRedactions.eventId, emailEvent.id));
    expect(emailDetail.fieldCategory).toBe('email');

    const smsRes = await POST(
      req(
        'POST',
        {
          action: 'redactContactMethod',
          contactMethodId: 'cm-sms-1',
          authorityKind: 'binding_policy',
          authorityReference: 'Board Policy 4',
          reason: 'resident_request',
        },
        systemAdminContext(),
      ),
    );
    expect(smsRes.status).toBe(204);
    const [smsRow] = await getDb(env)
      .select()
      .from(contactMethods)
      .where(eq(contactMethods.id, 'cm-sms-1'));
    expect(smsRow.value).toBeNull();
    expect(smsRow.valueNormalized).toBeNull();

    const events = await getDb(env).select().from(auditEvents);
    const smsEvent = events.find((e) => e.id !== emailEvent.id)!;
    const [smsDetail] = await getDb(env)
      .select()
      .from(rosterRedactions)
      .where(eq(rosterRedactions.eventId, smsEvent.id));
    expect(smsDetail.fieldCategory).toBe('phone');

    // Second redaction of the same value is refused.
    const dup = await POST(
      req(
        'POST',
        {
          action: 'redactContactMethod',
          contactMethodId: 'cm-email-1',
          authorityKind: 'binding_policy',
          authorityReference: 'Board Policy 4',
          reason: 'resident_request',
        },
        systemAdminContext(),
      ),
    );
    expect(dup.status).toBe(409);
    expect(await dup.text()).toBe('Value already redacted');
  });

  it('returns 404 for an unknown contact method', async () => {
    await seedAccount('sa');
    const res = await POST(
      req(
        'POST',
        {
          action: 'redactContactMethod',
          contactMethodId: 'nope',
          authorityKind: 'binding_policy',
          authorityReference: 'x',
          reason: 'x',
        },
        systemAdminContext(),
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('redactions admin route — recordCleanup', () => {
  async function seedPendingTask(): Promise<string> {
    await seedAccount('sa');
    await seedPerson('per-4', 'Cleanup Person');
    await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'per-4',
          authorityKind: 'legal_requirement',
          authorityReference: 'Ref',
          reason: 'code',
        },
        systemAdminContext(),
      ),
    );
    const [task] = await getDb(env).select().from(redactionTasks);
    return task.id;
  }

  it('failed records last_error_code and stays re-runnable; succeeded stamps completed_at; already-succeeded 409s', async () => {
    const taskId = await seedPendingTask();
    const [pending] = await getDb(env)
      .select()
      .from(redactionTasks)
      .where(eq(redactionTasks.id, taskId));
    expect(pending.status).toBe('pending');
    expect(pending.attempts).toBe(0);

    const failRes = await POST(
      req(
        'POST',
        {
          action: 'recordCleanup',
          taskId,
          status: 'failed',
          errorCode: 'rag_purge_timeout',
        },
        systemAdminContext(),
      ),
    );
    expect(failRes.status).toBe(204);
    const [afterFail] = await getDb(env)
      .select()
      .from(redactionTasks)
      .where(eq(redactionTasks.id, taskId));
    expect(afterFail.status).toBe('failed');
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.lastErrorCode).toBe('rag_purge_timeout');
    expect(afterFail.completedAt).toBeNull();

    // Still re-runnable: a failed task's status is not 'succeeded', so the
    // WHERE status <> 'succeeded' precondition still admits it.
    const succeedRes = await POST(
      req(
        'POST',
        { action: 'recordCleanup', taskId, status: 'succeeded' },
        systemAdminContext(),
      ),
    );
    expect(succeedRes.status).toBe(204);
    const [afterSucceed] = await getDb(env)
      .select()
      .from(redactionTasks)
      .where(eq(redactionTasks.id, taskId));
    expect(afterSucceed.status).toBe('succeeded');
    expect(afterSucceed.attempts).toBe(2);
    expect(afterSucceed.completedAt).not.toBeNull();

    const againRes = await POST(
      req(
        'POST',
        { action: 'recordCleanup', taskId, status: 'succeeded' },
        systemAdminContext(),
      ),
    );
    expect(againRes.status).toBe(409);
    expect(await againRes.text()).toBe('Task already succeeded');

    // recordCleanup writes no ledger event at all — only the one
    // roster_redaction event from the original redaction exists.
    expect(await getDb(env).select().from(auditEvents)).toHaveLength(1);
  });

  it('returns 404 for an unknown task and 400 for a bad status', async () => {
    await seedAccount('sa');
    const missing = await POST(
      req(
        'POST',
        { action: 'recordCleanup', taskId: 'nope', status: 'succeeded' },
        systemAdminContext(),
      ),
    );
    expect(missing.status).toBe(404);

    const taskId = await seedPendingTask();
    const badStatus = await POST(
      req(
        'POST',
        { action: 'recordCleanup', taskId, status: 'done' },
        systemAdminContext(),
      ),
    );
    expect(badStatus.status).toBe(400);
  });

  it('refuses a plain board caller, who lacks redactionCleanup', async () => {
    const res = await POST(
      req(
        'POST',
        { action: 'recordCleanup', taskId: 'whatever', status: 'succeeded' },
        legacyAuthContext('b', 'board', []),
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe('redactions admin route — capability boundary', () => {
  it('refuses a plain board caller on GET and on a redact action', async () => {
    const getRes = await GET(req('GET', undefined, legacyAuthContext('b', 'board', [])));
    expect(getRes.status).toBe(403);

    const postRes = await POST(
      req(
        'POST',
        {
          action: 'redactPersonName',
          personId: 'whatever',
          authorityKind: 'legal_requirement',
          authorityReference: 'x',
          reason: 'x',
        },
        legacyAuthContext('b', 'board', []),
      ),
    );
    expect(postRes.status).toBe(403);
  });
});
