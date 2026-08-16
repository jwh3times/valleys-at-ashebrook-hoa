import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import type { AuthContext } from '../../src/server/authz/guards';
import { legacyAuthContext } from '../../src/server/authz/context';
import { GET, POST } from '../../src/pages/api/admin/review-flags';
import type { ReviewFlagRow } from '../../src/pages/api/admin/review-flags';

/**
 * #220's Review Flag queue: the board's read surface over every flag phase 3d
 * opens, and the one place a human resolves one.
 *
 * Flags are seeded directly here rather than driven through a transfer — this
 * route is the queue, not the writer, and the shape it must render (a caused
 * `review_flag_opened` event under an account-attributed root, with a typed
 * impacted reference) is exactly what the writer produces. Nothing in this
 * file names, joins, or counts `ballot_choices`: a flag reaches a turnout row
 * and stops there.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const url = 'http://localhost/api/admin/review-flags';

// Children before parents; the ledger's caused events before their roots.
const CLEAR = [
  'review_events',
  'review_flags',
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'roster_change_subjects',
  'roster_changes',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  // Two-pass: consequences name their root through a RESTRICT self-FK.
  await db.run(
    sql.raw('DELETE FROM audit_events WHERE causing_event_id IS NOT NULL'),
  );
  await db.run(sql.raw('DELETE FROM audit_events'));
  await db.run(sql.raw('DELETE FROM motions'));
  await db.run(sql.raw('DELETE FROM meetings'));
  await db.run(sql.raw('DELETE FROM users'));
  await seedAccount('board-1');
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

const IMPACT_COLUMNS = new Set([
  'impacted_proxy_id',
  'impacted_member_attendance_id',
  'impacted_member_vote_id',
  'impacted_motion_id',
  'impacted_ballot_id',
  'impacted_board_term_id',
  'impacted_access_grant_id',
  'impacted_event_id',
]);

/**
 * One flag as the transfer-effects writer produces it: an account-attributed
 * root (the roster change that caused everything), a caused automatic
 * `review_flag_opened` event, and the flag row pointing at that event.
 */
async function seedFlag(opts: {
  flagId: string;
  category:
    | 'intervening_action_backdated'
    | 'authority_lost_pending_occasion'
    | 'vote_reset_on_transfer'
    | 'ballot_final_after_transfer';
  openedAt: number;
  resolved?: { at: number; code: string };
  impact?: { column: string; id: string };
}): Promise<{ rootId: string; openEventId: string }> {
  const rootId = `root-${opts.flagId}`;
  const openEventId = `open-${opts.flagId}`;
  const recordedAt = opts.openedAt;

  await env.DATABASE.prepare(
    `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
     VALUES (?, 'roster_change', 'ownership_ended', ?, 0, 'account', 'board-1', ?, ?)`,
  )
    .bind(rootId, `corr-${opts.flagId}`, `opkey-${opts.flagId}`, recordedAt)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO roster_changes (event_id, effective_day, effective_day_basis, reason_code, evidence_kind)
     VALUES (?, NULL, 'not_applicable', 'ownership_transfer', 'operator_observation')`,
  )
    .bind(rootId)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, causing_event_id, actor_kind, automatic_cause, recorded_at)
     VALUES (?, 'review', 'review_flag_opened', ?, 1, ?, 'automatic', 'ownership_ended', ?)`,
  )
    .bind(openEventId, `corr-${opts.flagId}`, rootId, recordedAt)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO review_events (event_id, review_flag_id, resolution_code) VALUES (?, ?, NULL)`,
  )
    .bind(openEventId, opts.flagId)
    .run();

  const column = opts.impact?.column;
  if (column && !IMPACT_COLUMNS.has(column))
    throw new Error(`illegal impact column ${column}`);
  const extraColumn = column ? `, ${column}` : '';
  const extraValue = column ? ', ?' : '';
  await env.DATABASE.prepare(
    `INSERT INTO review_flags (id, category, source_event_id, status, opened_at, resolved_at, resolution_code${extraColumn})
     VALUES (?, ?, ?, ?, ?, ?, ?${extraValue})`,
  )
    .bind(
      opts.flagId,
      opts.category,
      openEventId,
      opts.resolved ? 'resolved' : 'open',
      opts.openedAt,
      opts.resolved ? opts.resolved.at : null,
      opts.resolved ? opts.resolved.code : null,
      ...(column ? [opts.impact!.id] : []),
    )
    .run();

  return { rootId, openEventId };
}

async function seedMotion(motionId: string) {
  const now = Math.floor(Date.now() / 1000);
  await env.DATABASE.prepare(
    `INSERT INTO meetings (id, body, kind, date, title, status, visibility, created_by, created_at, updated_at)
     VALUES ('meet-1', 'member', 'annual', '2026-03-01', 'Annual meeting', 'draft', 'board', 'board-1', ?, ?)`,
  )
    .bind(now, now)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO motions (id, meeting_id, sequence, text, voting_state, voting_revision, outcome, created_by, created_at, updated_at)
     VALUES (?, 'meet-1', 1, 'That the budget be adopted', 'open', 0, 'tabled', 'board-1', ?, ?)`,
  )
    .bind(motionId, now, now)
    .run();
}

const board: AuthContext = legacyAuthContext('board-1', 'board', []);

function get(ctx: AuthContext | null) {
  return GET({
    request: new Request(url, { method: 'GET' }),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

function post(body: unknown, ctx: AuthContext | null) {
  return POST({
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never) as Promise<Response>;
}

async function flagRow(id: string) {
  return env.DATABASE.prepare('SELECT * FROM review_flags WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
}

async function countEvents(): Promise<number> {
  const row = await env.DATABASE.prepare(
    'SELECT COUNT(*) AS n FROM audit_events',
  ).first<{ n: number }>();
  return row!.n;
}

describe('GET /api/admin/review-flags', () => {
  it('returns the full register, open first then most recently opened', async () => {
    await seedMotion('motion-1');
    await seedFlag({
      flagId: 'flag-old-open',
      category: 'authority_lost_pending_occasion',
      openedAt: 1_000,
    });
    await seedFlag({
      flagId: 'flag-new-open',
      category: 'vote_reset_on_transfer',
      openedAt: 3_000,
      impact: { column: 'impacted_motion_id', id: 'motion-1' },
    });
    await seedFlag({
      flagId: 'flag-resolved',
      category: 'intervening_action_backdated',
      openedAt: 5_000,
      resolved: { at: 6_000, code: 'no_effect' },
    });

    const res = await get(board);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as ReviewFlagRow[];
    // Resolved flags stay in the register — the queue is history, not a
    // to-do list that forgets what it decided.
    expect(rows.map((r) => r.id)).toEqual([
      'flag-new-open',
      'flag-old-open',
      'flag-resolved',
    ]);
  });

  it('renders the typed impacted reference and the source event summary', async () => {
    await seedMotion('motion-1');
    await seedFlag({
      flagId: 'flag-reset',
      category: 'vote_reset_on_transfer',
      openedAt: 2_000,
      impact: { column: 'impacted_motion_id', id: 'motion-1' },
    });

    const rows = (await (await get(board)).json()) as ReviewFlagRow[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.category).toBe('vote_reset_on_transfer');
    expect(row.status).toBe('open');
    expect(row.openedAt).toBe(2_000);
    expect(row.resolvedAt).toBeNull();
    expect(row.resolutionCode).toBeNull();
    expect(row.impacted).toEqual({ kind: 'motion', id: 'motion-1' });
    expect(row.sourceEventId).toBe('open-flag-reset');
    expect(row.sourceEvent).toEqual({
      eventKind: 'review_flag_opened',
      family: 'review',
      recordedAt: 2_000,
      actorKind: 'automatic',
      actorAccountId: null,
      automaticCause: 'ownership_ended',
    });
  });

  it('renders a resolved flag with its code and a null impacted reference', async () => {
    await seedFlag({
      flagId: 'flag-done',
      category: 'ballot_final_after_transfer',
      openedAt: 1_000,
      resolved: { at: 4_000, code: 'confirmed_valid' },
    });
    const rows = (await (await get(board)).json()) as ReviewFlagRow[];
    expect(rows[0].status).toBe('resolved');
    expect(rows[0].resolvedAt).toBe(4_000);
    expect(rows[0].resolutionCode).toBe('confirmed_valid');
    expect(rows[0].impacted).toBeNull();
  });

  it('returns an empty register when nothing is flagged', async () => {
    const res = await get(board);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('POST /api/admin/review-flags resolve', () => {
  it('resolves an open flag and records one account-attributed review event', async () => {
    await seedFlag({
      flagId: 'flag-1',
      category: 'authority_lost_pending_occasion',
      openedAt: 1_000,
    });

    const res = await post(
      { action: 'resolve', id: 'flag-1', resolutionCode: 'remediated' },
      board,
    );
    expect(res.status).toBe(204);

    const flag = await flagRow('flag-1');
    expect(flag!.status).toBe('resolved');
    expect(flag!.resolution_code).toBe('remediated');
    expect(flag!.resolved_at).not.toBeNull();

    // Two review_events reference the flag: the opening (no code) and this
    // resolution. Exactly one carries the code.
    const details = await env.DATABASE.prepare(
      'SELECT event_id, resolution_code FROM review_events WHERE review_flag_id = ?',
    )
      .bind('flag-1')
      .all<{ event_id: string; resolution_code: string | null }>();
    expect(details.results).toHaveLength(2);
    const resolutions = details.results.filter(
      (r) => r.resolution_code === 'remediated',
    );
    expect(resolutions).toHaveLength(1);

    const event = await env.DATABASE.prepare(
      'SELECT * FROM audit_events WHERE id = ?',
    )
      .bind(resolutions[0].event_id)
      .first<Record<string, unknown>>();
    expect(event!.family).toBe('review');
    expect(event!.event_kind).toBe('review_flag_resolved');
    // A resolution is a human decision: a ROOT, attributed to the account,
    // never an automatic consequence.
    expect(event!.correlation_sequence).toBe(0);
    expect(event!.actor_kind).toBe('account');
    expect(event!.actor_account_id).toBe('board-1');
    expect(event!.causing_event_id).toBeNull();
    expect(event!.operation_key).not.toBeNull();
  });

  it('accepts each of the three human resolution codes', async () => {
    for (const code of ['remediated', 'confirmed_valid', 'no_effect']) {
      await seedFlag({
        flagId: `flag-${code}`,
        category: 'intervening_action_backdated',
        openedAt: 1_000,
      });
      const res = await post(
        { action: 'resolve', id: `flag-${code}`, resolutionCode: code },
        board,
      );
      expect([code, res.status]).toEqual([code, 204]);
      expect((await flagRow(`flag-${code}`))!.resolution_code).toBe(code);
    }
  });

  it('refuses to re-resolve a resolved flag and writes no ledger row', async () => {
    await seedFlag({
      flagId: 'flag-done',
      category: 'ballot_final_after_transfer',
      openedAt: 1_000,
      resolved: { at: 2_000, code: 'no_effect' },
    });
    const before = await countEvents();

    const res = await post(
      { action: 'resolve', id: 'flag-done', resolutionCode: 'remediated' },
      board,
    );
    expect(res.status).toBe(409);
    expect(await countEvents()).toBe(before);
    const flag = await flagRow('flag-done');
    expect(flag!.resolution_code).toBe('no_effect');
    expect(flag!.resolved_at).toBe(2_000);
  });

  it("refuses 'superseded' as reserved for the automatic path", async () => {
    await seedFlag({
      flagId: 'flag-1',
      category: 'vote_reset_on_transfer',
      openedAt: 1_000,
    });
    const res = await post(
      { action: 'resolve', id: 'flag-1', resolutionCode: 'superseded' },
      board,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('superseded');
    expect((await flagRow('flag-1'))!.status).toBe('open');
  });

  it('refuses an unknown resolution code, a missing id, and an unknown action', async () => {
    await seedFlag({
      flagId: 'flag-1',
      category: 'vote_reset_on_transfer',
      openedAt: 1_000,
    });
    expect(
      (
        await post(
          { action: 'resolve', id: 'flag-1', resolutionCode: 'whatever' },
          board,
        )
      ).status,
    ).toBe(400);
    expect(
      (await post({ action: 'resolve', resolutionCode: 'remediated' }, board))
        .status,
    ).toBe(400);
    expect((await post({ action: 'delete', id: 'flag-1' }, board)).status).toBe(
      400,
    );
    expect((await flagRow('flag-1'))!.status).toBe('open');
  });

  it('answers 404 for an unknown flag id', async () => {
    const res = await post(
      { action: 'resolve', id: 'no-such-flag', resolutionCode: 'remediated' },
      board,
    );
    expect(res.status).toBe(404);
  });

  it('answers 400 for a malformed body', async () => {
    const res = await post('not json at all', board);
    expect(res.status).toBe(400);
  });
});

describe('the review-flags route front door', () => {
  it('refuses an anonymous caller on both verbs', async () => {
    const read = await (GET as (c: unknown) => Promise<Response>)({
      request: new Request(url, { method: 'GET' }),
    });
    expect(read.status).toBe(401);
    const write = await (POST as (c: unknown) => Promise<Response>)({
      request: new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    });
    expect(write.status).toBe(401);
  });
});
