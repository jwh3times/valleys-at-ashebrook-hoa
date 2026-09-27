import { getTableColumns, getTableName, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as roster from '../db/roster-schema';
import {
  lots,
  meetings,
  motions,
  memberVotes,
  memberAttendance,
  ballots,
  elections,
  proxies,
} from '../db/schema';
import { reviewFlags } from '../db/audit-schema';
import { personDisplayLabel } from '../../lib/format';
import { isoDateOrError } from '../../lib/types';
import { stringField } from '../http';
import { CAPABILITY_SQL, LOT_SQL } from '../authz/derive';
import { lotAuthorityExists } from './authority';
import { lossConsequences, qualifiesGuard } from './board-consequences';
import { transferEffects } from './transfer-effects';
import { parseEvidence, parseSubstitutions } from './ownership-input';
import {
  AuditCorrelation,
  assertInBatch,
  insertedRowGuard,
  isBatchAssertionError,
  operationKey,
  type Evidence,
  type SqlGuard,
} from './audit';
import type { OwnershipTransferPreview } from '../../lib/ownership-transfer';

// A preview is bound to the facts its engines read. Comparing the same ordered
// projection in the transaction also catches changes after commit's preflight.
// Conservative invalidation is intentional: an unrelated roster edit can ask
// for another preview, but no new consequence can silently bypass confirmation.
const snapshotTables = [
  lots,
  roster.parties,
  roster.people,
  roster.organizations,
  roster.ownerships,
  roster.representations,
  roster.representationLots,
  roster.personLinks,
  roster.boardTerms,
  roster.boardOfficeAssignments,
  roster.accessGrants,
  meetings,
  motions,
  memberVotes,
  memberAttendance,
  ballots,
  elections,
  proxies,
  reviewFlags,
];
const snapshotSql = `SELECT json_array(${snapshotTables
  .map((table) => {
    const columns = Object.values(getTableColumns(table))
      .map((column) => `"${column.name}"`)
      .join(', ');
    return `(SELECT json_group_array(json_array(${columns})) FROM (SELECT ${columns} FROM "${getTableName(table)}" ORDER BY ${columns}))`;
  })
  .join(', ')}, (SELECT COUNT(*) FROM audit_events),
  (SELECT COALESCE(MAX(recorded_at), 0) FROM audit_events),
  (SELECT json_group_array(json_array(key, value)) FROM (SELECT key, value FROM cutover_settings ORDER BY key))) AS snapshot`;

class TransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
interface TransferInput {
  lotId: string;
  departingOwnershipIds: string[];
  incomingPartyIds: string[];
  effectiveDay: string;
  evidence: Evidence;
  substitutions: Map<string, string>;
}
function ids(body: Record<string, unknown>, key: string): string[] {
  const raw = body[key];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    throw new TransferError(`${key} must be a non-empty list of IDs`, 400);
  }
  const values = (raw as string[]).map((id) => id.trim());
  if (new Set(values).size !== values.length)
    throw new TransferError(`${key} contains duplicate IDs`, 400);
  return values.sort();
}
function parse(body: unknown, today: string): TransferInput {
  if (!body || typeof body !== 'object')
    throw new TransferError('Transfer details are required', 400);
  const raw = body as Record<string, unknown>;
  const lotId = stringField(body, 'lotId');
  if (!lotId) throw new TransferError('lotId is required', 400);
  const day = isoDateOrError(stringField(body, 'effectiveDay'), 'effectiveDay');
  if (!day.ok) throw new TransferError(day.error, 400);
  if (day.value > today)
    throw new TransferError('effectiveDay may not be in the future', 400);
  const evidence = parseEvidence(body);
  if (!evidence.ok) throw new TransferError(evidence.error, 400);
  const substitutions = parseSubstitutions(body);
  if (!substitutions.ok) throw new TransferError(substitutions.error, 400);
  return {
    lotId,
    effectiveDay: day.value,
    departingOwnershipIds: ids(raw, 'departingOwnershipIds'),
    incomingPartyIds: ids(raw, 'incomingPartyIds'),
    evidence: evidence.value,
    substitutions: substitutions.value,
  };
}
async function snapshot(database: D1Database): Promise<string> {
  const row = await database.prepare(snapshotSql).first<{ snapshot: string }>();
  if (!row) throw new Error('Transfer state unavailable');
  return row.snapshot;
}

// Read-only shadow of the Ownership relation. Reuse the real authority SQL
// against the proposed final state instead of maintaining another access rule.
const projectedOwnerships = `ownerships AS (
  SELECT id, owner_party_id, lot_id, start_day,
    CASE WHEN id IN (SELECT value FROM json_each(?1)) THEN ?2 ELSE end_day END AS end_day,
    voided_at FROM main.ownerships
  UNION ALL
  SELECT 'proposed:' || value, value, ?4, ?2, NULL, NULL FROM json_each(?3)
)`;
function projectionBinds(input: TransferInput): string[] {
  return [
    JSON.stringify(input.departingOwnershipIds),
    input.effectiveDay,
    JSON.stringify(input.incomingPartyIds),
    input.lotId,
  ];
}
async function projectedCheck(
  database: D1Database,
  input: TransferInput,
  guard: SqlGuard,
): Promise<boolean> {
  const row = await database
    .prepare(`WITH ${projectedOwnerships} SELECT ${guard.sql} AS valid`)
    .bind(...projectionBinds(input), ...guard.binds)
    .first<{ valid: number }>();
  return row?.valid === 1;
}
async function tokenFor(
  state: string,
  input: TransferInput,
  today: string,
): Promise<string> {
  const data = JSON.stringify([
    state,
    input.lotId,
    input.departingOwnershipIds,
    input.incomingPartyIds,
    input.effectiveDay,
    input.evidence,
    [...input.substitutions].sort(([a], [b]) => a.localeCompare(b)),
    today,
  ]);
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function planTransfer(
  env: Env,
  input: TransferInput,
  today: string,
  actorAccountId: string,
) {
  const database = env.DATABASE;
  const db = getDb(env);
  const state = await snapshot(database);
  const [lot] = await db.select().from(lots).where(eq(lots.id, input.lotId));
  if (!lot) throw new TransferError('Lot not found', 404);
  if (lot.retiredAt !== null) throw new TransferError('Lot is retired', 409);
  const existing = await db
    .select()
    .from(roster.ownerships)
    .where(eq(roster.ownerships.lotId, input.lotId));
  const departing = input.departingOwnershipIds.map((id) => {
    const row = existing.find((ownership) => ownership.id === id);
    if (!row)
      throw new TransferError('Departing Ownership not found on this Lot', 404);
    if (row.voidedAt !== null || row.endDay !== null)
      throw new TransferError(
        'A departing Ownership is no longer current',
        409,
      );
    if (row.startDay !== null && input.effectiveDay <= row.startDay)
      throw new TransferError(
        'effectiveDay must be after every departing Ownership start day',
        400,
      );
    return row;
  });
  const [parties, people, organizations] = await Promise.all([
    db.select().from(roster.parties),
    db.select().from(roster.people),
    db.select().from(roster.organizations),
  ]);
  const label = (id: string): string => {
    const person = people.find((row) => row.partyId === id);
    if (person) return personDisplayLabel(person.fullName, id);
    const organization = organizations.find((row) => row.partyId === id);
    return organization?.displayName ?? organization?.legalName ?? id;
  };
  for (const id of input.incomingPartyIds) {
    const party = parties.find((row) => row.id === id);
    if (!party) throw new TransferError('Incoming Party not found', 404);
    if (party.consolidatedIntoPartyId !== null)
      throw new TransferError(
        'Incoming Party has been consolidated — use the survivor',
        409,
      );
    if (departing.some((row) => row.ownerPartyId === id))
      throw new TransferError(
        'Departing and incoming owners must be different',
        400,
      );
    if (
      existing.some(
        (row) =>
          row.ownerPartyId === id &&
          row.voidedAt === null &&
          (row.endDay === null || row.endDay > input.effectiveDay),
      )
    ) {
      throw new TransferError(
        'Incoming owner already has an overlapping Ownership of this Lot',
        409,
      );
    }
  }
  const authority = lotAuthorityExists(
    { column: 'people.party_id' },
    { value: input.lotId },
    today,
  );
  const beforePeople = await database
    .prepare(`SELECT party_id FROM people WHERE ${authority.sql}`)
    .bind(...authority.binds)
    .all<{ party_id: string }>();
  const afterPeople = await database
    .prepare(
      `WITH ${projectedOwnerships} SELECT party_id FROM people WHERE ${authority.sql}`,
    )
    .bind(...projectionBinds(input), ...authority.binds)
    .all<{ party_id: string }>();
  const beforeIds = new Set(beforePeople.results.map((row) => row.party_id));
  const afterIds = new Set(afterPeople.results.map((row) => row.party_id));
  const links = await db.select().from(roster.personLinks);
  const access: OwnershipTransferPreview['access'] = [];
  for (const link of links.filter((row) => row.endedAt === null)) {
    const before = await database
      .prepare(LOT_SQL)
      .bind(link.accountId, today)
      .all<{ lot_id: string }>();
    const projectedLotSql = LOT_SQL.replace(
      /\?(\d+)/g,
      (_, index: string) => `?${Number(index) + 4}`,
    ).replace('WITH me AS', `WITH ${projectedOwnerships}, me AS`);
    const after = await database
      .prepare(projectedLotSql)
      .bind(...projectionBinds(input), link.accountId, today)
      .all<{ lot_id: string }>();
    const hadLot = before.results.some((row) => row.lot_id === input.lotId);
    const hasLot = after.results.some((row) => row.lot_id === input.lotId);
    if (hadLot !== hasLot)
      access.push({
        personId: link.personId,
        displayName: label(link.personId),
        lotAuthority: hasLot ? 'gained' : 'lost',
        memberAccess:
          before.results.length > 0 && after.results.length === 0
            ? 'lost'
            : before.results.length === 0 && after.results.length > 0
              ? 'gained'
              : 'retained',
      });
  }
  const allTerms = await db.select().from(roster.boardTerms);
  const terms = allTerms.filter(
    (term) =>
      term.qualifyingLotId === input.lotId &&
      term.actualEndDay === null &&
      term.cancelledAt === null &&
      term.voidedAt === null &&
      today < term.scheduledEndDay,
  );
  const termPreview: OwnershipTransferPreview['boardTerms'] = [];
  const affected = new Set<string>();
  for (const term of terms) {
    if (
      await projectedCheck(
        database,
        input,
        qualifiesGuard(term.personId, input.lotId, today),
      )
    )
      continue;
    affected.add(term.id);
    const candidateAuthority = lotAuthorityExists(
      { value: term.personId },
      { column: 'lots.id' },
      today,
    );
    const options = await database
      .prepare(
        `WITH ${projectedOwnerships} SELECT id, address FROM lots WHERE retired_at IS NULL AND ${candidateAuthority.sql}`,
      )
      .bind(...projectionBinds(input), ...candidateAuthority.binds)
      .all<{ id: string; address: string }>();
    const available = options.results.filter(
      (option) =>
        !allTerms.some(
          (other) =>
            other.id !== term.id &&
            other.qualifyingLotId === option.id &&
            other.cancelledAt === null &&
            other.voidedAt === null &&
            other.startDay < term.scheduledEndDay &&
            (other.actualEndDay ?? other.scheduledEndDay) > term.startDay,
        ),
    );
    const substitute = input.substitutions.get(term.id);
    if (substitute && !available.some((option) => option.id === substitute))
      throw new TransferError(
        'A named substitute Lot no longer qualifies',
        409,
      );
    const [offices, grants] = await Promise.all([
      db
        .select()
        .from(roster.boardOfficeAssignments)
        .where(eq(roster.boardOfficeAssignments.boardTermId, term.id)),
      db
        .select()
        .from(roster.accessGrants)
        .where(eq(roster.accessGrants.qualifyingBoardTermId, term.id)),
    ]);
    termPreview.push({
      termId: term.id,
      personId: term.personId,
      displayName: label(term.personId),
      action: substitute
        ? 'substitute'
        : term.startDay >= input.effectiveDay
          ? 'cancel'
          : 'end',
      substituteLotId: substitute ?? null,
      availableLots: available,
      offices: offices
        .filter((row) => row.endDay === null && row.voidedAt === null)
        .map((row) => row.office),
      boardGrantsEnding: substitute
        ? 0
        : grants.filter(
            (row) => row.grantType === 'board' && row.endedAt === null,
          ).length,
    });
  }
  for (const id of input.substitutions.keys())
    if (!affected.has(id))
      throw new TransferError(
        'Substitution names a Board Term that does not lose qualification',
        400,
      );
  const usedLots = termPreview
    .map((term) => term.substituteLotId)
    .filter((id) => id !== null);
  if (new Set(usedLots).size !== usedLots.length)
    throw new TransferError(
      'Two Board Terms cannot use the same substitute Lot',
      409,
    );

  const nowMs = Date.now();
  const incoming = input.incomingPartyIds.map((ownerPartyId) => ({
    id: crypto.randomUUID(),
    ownerPartyId,
  }));
  const rootGuard = insertedRowGuard('ownerships', incoming[0].id);
  const correlation = new AuditCorrelation(database, {
    operationKey: operationKey('roster-ownerships', 'transfer'),
    actorAccountId,
    nowMs,
  });
  correlation.event({
    kind: 'ownership_transfer_recorded',
    guard: rootGuard,
    detail: {
      family: 'roster_change',
      effective: { day: input.effectiveDay },
      reason: 'ownership_transfer',
      evidence: input.evidence,
      subjects: [
        { column: 'lot_id', id: input.lotId, role: 'related' },
        ...departing.map((row) => ({
          column: 'ownership_id' as const,
          id: row.id,
          role: 'ended' as const,
        })),
      ],
    },
  });
  for (const row of departing)
    correlation.event({
      kind: 'ownership_ended',
      guard: rootGuard,
      detail: {
        family: 'roster_change',
        effective: { day: input.effectiveDay },
        reason: 'ownership_transfer',
        evidence: input.evidence,
        subjects: [
          { column: 'ownership_id', id: row.id, role: 'ended' },
          { column: 'lot_id', id: input.lotId, role: 'related' },
          { column: 'party_id', id: row.ownerPartyId, role: 'related' },
        ],
      },
    });
  for (const row of incoming)
    correlation.event({
      kind: 'ownership_created',
      guard: rootGuard,
      detail: {
        family: 'roster_change',
        effective: { day: input.effectiveDay },
        reason: 'ownership_transfer',
        evidence: input.evidence,
        subjects: [
          { column: 'ownership_id', id: row.id, role: 'created' },
          { column: 'lot_id', id: input.lotId, role: 'related' },
          { column: 'party_id', id: row.ownerPartyId, role: 'related' },
        ],
      },
    });
  const consequences = await lossConsequences({
    database,
    nowMs,
    associationDay: today,
    effectiveDay: input.effectiveDay,
    lots: [input.lotId],
    rootGuard,
    substitutions: input.substitutions,
    cause: 'ownership_ended',
    correlation,
    actorAccountId,
  });
  const effects = await transferEffects({
    database,
    nowMs,
    associationDay: today,
    effectiveDay: input.effectiveDay,
    lots: [input.lotId],
    rootGuard,
    correlation,
    cause: 'ownership_ended',
    resetOpenMotionVotes: true,
    affectedTermIds: consequences.affectedTermIds,
  });
  if (state !== (await snapshot(database)))
    throw new TransferError(
      'Transfer data changed — request a new preview',
      409,
    );
  const preview: OwnershipTransferPreview = {
    token: await tokenFor(state, input, today),
    lotId: input.lotId,
    address: lot.address,
    effectiveDay: input.effectiveDay,
    departing: departing.map((row) => ({
      id: row.ownerPartyId,
      displayName: label(row.ownerPartyId),
    })),
    incoming: incoming.map((row) => ({
      id: row.ownerPartyId,
      displayName: label(row.ownerPartyId),
    })),
    retained: existing
      .filter(
        (row) =>
          row.voidedAt === null &&
          row.endDay === null &&
          !input.departingOwnershipIds.includes(row.id),
      )
      .map((row) => ({
        id: row.ownerPartyId,
        displayName: label(row.ownerPartyId),
      })),
    authorityLost: [...beforeIds]
      .filter((id) => !afterIds.has(id))
      .map((id) => ({ id, displayName: label(id) })),
    authorityGained: [...afterIds]
      .filter((id) => !beforeIds.has(id))
      .map((id) => ({ id, displayName: label(id) })),
    access,
    boardTerms: termPreview,
    resetMotionIds: effects.resetMotionIds,
    reviewFlagCount: effects.openedFlagCount,
  };
  return {
    input,
    preview,
    state,
    incoming,
    nowMs,
    rootGuard,
    correlation,
    consequences,
    effects,
  };
}

export async function ownershipTransfer(
  env: Env,
  body: unknown,
  today: string,
  actorAccountId: string,
  commit: boolean,
): Promise<Response> {
  try {
    const input = parse(body, today);
    const plan = await planTransfer(env, input, today, actorAccountId);
    if (!commit)
      return Response.json(plan.preview, {
        headers: { 'cache-control': 'no-store' },
      });
    if (stringField(body, 'previewToken') !== plan.preview.token)
      throw new TransferError(
        'Transfer preview is stale — review a new preview before confirming',
        409,
      );
    const database = env.DATABASE;
    // Revalidate the caller and freeze in the transaction, including a loss
    // that happened before planTransfer captured its state.
    const capabilityBinds: string[] = [];
    const capabilitySql = CAPABILITY_SQL.replace(
      /\?([12])/g,
      (_, index: string) => {
        capabilityBinds.push(index === '1' ? actorAccountId : today);
        return '?';
      },
    );
    const statements = [
      assertInBatch(database, {
        sql: `EXISTS (SELECT 1 FROM (${capabilitySql}) WHERE has_board = 1 OR has_system_admin = 1)
          AND NOT EXISTS (SELECT 1 FROM cutover_settings WHERE key = 'write_freeze' AND value <> 'off')`,
        binds: capabilityBinds,
      }),
      assertInBatch(database, {
        sql: `(${snapshotSql}) = ?`,
        binds: [plan.state],
      }),
      database
        .prepare(
          'UPDATE ownerships SET end_day = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))',
        )
        .bind(
          input.effectiveDay,
          plan.nowMs,
          JSON.stringify(input.departingOwnershipIds),
        ),
      assertInBatch(database, {
        sql: 'changes() = ?',
        binds: [input.departingOwnershipIds.length],
      }),
      ...plan.incoming.map((row) =>
        database
          .prepare(
            'INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(
            row.id,
            row.ownerPartyId,
            input.lotId,
            input.effectiveDay,
            plan.nowMs,
            plan.nowMs,
          ),
      ),
      ...plan.consequences.statements,
      ...plan.effects.statements,
      ...plan.correlation.statements,
      ...plan.effects.flagStatements,
      ...plan.consequences.substitutionAsserts.map((guard) =>
        assertInBatch(database, guard),
      ),
    ];
    await database.batch(statements);
    return Response.json({ ownershipIds: plan.incoming.map((row) => row.id) });
  } catch (error) {
    if (error instanceof TransferError)
      return new Response(error.message, { status: error.status });
    if (isBatchAssertionError(error))
      return new Response(
        'Transfer data changed — review a new preview before confirming',
        { status: 409 },
      );
    throw error;
  }
}
