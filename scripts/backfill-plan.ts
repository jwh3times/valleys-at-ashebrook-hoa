// The ADR 0022 roster backfill's mapping rules, as a pure function.
//
// Deliberately separated from `scripts/migrate-roster.ts`: the script is I/O —
// read legacy rows through Wrangler, print, apply — while every decision that
// could be wrong lives here, where it can be tested against synthetic legacy
// data without a database. A migration whose rules are only exercised by
// running it against production is a migration nobody can review.
//
// The governing principle is **transform, never infer**. Where legacy data
// cannot answer a question the new model asks, the answer comes from a human
// before the flip, or the fact is not recorded at all. Nothing here classifies,
// merges, or links on its own authority — every judgment call becomes an
// exception instead.

import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '../src/server/roster/normalize.ts';

export interface LegacyProperty {
  id: string;
  status: string;
  notes?: string | null;
}
export interface LegacyOwner {
  id: string;
  property_id: string;
  full_name: string;
  phone?: string | null;
  email?: string | null;
  status: string;
  notes?: string | null;
}
export interface LegacyBoardPerson {
  id: string;
  full_name: string;
}
export interface LegacyBoardTerm {
  id: string;
  person_id: string;
  title?: string | null;
  term_start: string;
  term_end?: string | null;
}
export interface LegacyBoardAccount {
  id: string;
}

export interface LegacyData {
  properties: LegacyProperty[];
  owners: LegacyOwner[];
  boardPeople: LegacyBoardPerson[];
  boardTerms: LegacyBoardTerm[];
  boardAccounts: LegacyBoardAccount[];
}

/** Proceeding past a `blocking` exception would record something false, so
 * every one must be zero before the flip. `advisory` items are reviewed after
 * it, and carry no threshold — attaching one would turn them into blockers and
 * destroy the distinction. */
export type ExceptionQueue = 'blocking' | 'advisory';

export interface PlanException {
  queue: ExceptionQueue;
  kind: string;
  detail: string;
}

export interface PlanCounts {
  parties: number;
  contactMethods: number;
  ownerships: number;
  lotsRetired: number;
  boardTerms: number;
  baselineEvents: number;
}

export interface PlanOptions {
  /** The human who authorized the run. `actor_kind = 'migration'` is legal
   * only for this backfill and still names an account, the same shape that
   * makes bootstrap safe. Without one, no baseline is emitted. */
  operatorAccountId?: string | null;
  /**
   * `rehearsal` (phase 2) is a clean-replace whose only output is counts and
   * queues — nothing it writes records anything.
   *
   * `authoritative` (phase 3, inside the write-freeze) is INSERT-ONCE: it
   * deletes nothing, and idempotency comes from the deterministic ids instead.
   * A clean replace once the ledger is real would be deleting immutable
   * history, so the two modes are genuinely different acts rather than a flag
   * on one act.
   */
  mode?: 'rehearsal' | 'authoritative';
  /**
   * Operator classifications for `board_account_unclassified` (#222). The only
   * accepted value is `technical`: the account holds `role = 'board'` for
   * operational rather than governance reasons, so its blocking exception is
   * suppressed ON THE RECORD — the decision lands in `BackfillPlan.decisions` —
   * and NO rows are planned, because System Administration Access arrives only
   * via the System Administrator Bootstrap, never from the backfill. A Board
   * Member classification is deliberately not offered: it would need a
   * qualifying Lot and a scheduled end, which are Board-panel facts, not
   * command-line arguments; the flag grows only if a future site state ever
   * needs one.
   */
  classifications?: Record<string, 'technical'>;
}

export interface BackfillPlan {
  statements: string[];
  exceptions: PlanException[];
  counts: PlanCounts;
  /** Operator decisions the plan applied — printed so a suppressed exception
   * is a recorded judgment, never a silent absence. */
  decisions: string[];
}

/**
 * Deterministic, opaque ids derived from the legacy row they represent.
 *
 * Random ids would serve a clean-replace rehearsal, but they would make the
 * phase-3 insert-once run a different code path — and a migration whose two
 * modes differ is a migration with an untested mode. Hashing under a per-kind
 * namespace keeps ids stable across runs, keeps them opaque (no legacy id is
 * recoverable), and makes a diff between two runs mean something.
 */
export function derivedId(kind: string, legacyId: string): string {
  // Small synchronous FNV-1a-style digest: this runs in the Workers test pool
  // as well as under Node, and `node:crypto` is not uniformly available there.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `adr0022:${kind}:${legacyId}`;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= input.charCodeAt(input.length - 1 - i);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  const a = hex(h1);
  const b = hex(h2);
  const c = hex((h1 ^ h2) >>> 0);
  const d = hex((Math.imul(h1, 31) ^ h2) >>> 0);
  return `${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d}`;
}

const quote = (v: string | null): string =>
  v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;

/**
 * A REVIEW LIST, never a classification.
 *
 * The asymmetry is what justifies blocking on it: an auto-classified
 * Organization silently strips its Lot of all authority until a Representative
 * is recorded, while an entity mistaken for a Person gains direct authority it
 * must never have. Word boundaries matter — a substring match on `co`, `lp`, or
 * `inc` fires on ordinary surnames.
 */
const ORG_HINTS =
  /\b(llc|inc|incorporated|corp|corporation|company|trust|revocable|bank|properties|holdings|lp|llp|partners|realty|foundation|ventures|management)\b/i;

/** Legacy `title` is free text and maps only on a clean match. Anything else
 * migrates officeless and is listed, because guessing is how "Vice-Pres."
 * silently becomes nothing. */
export function mapOffice(title: string | null | undefined): string | null {
  const n = normalizeName(title);
  if (!n) return null;
  if (n.includes('vice')) return 'vice_president';
  if (n.includes('president')) return 'president';
  if (n.includes('secretary') || n.includes('treasurer'))
    return 'secretary_treasurer';
  return null;
}

/**
 * Emits one correlation: an initiating event plus its caused consequences.
 *
 * Per the ledger's rules, the initiating event takes correlation sequence 0,
 * carries a globally unique operation key, and has no cause; every consequence
 * takes an increasing positive sequence, names its cause, and carries no key.
 *
 * Correlations are per migrated ROOT ENTITY rather than one for the whole run.
 * Per-entity correlations stay resumable and diffable; a single correlation for
 * thousands of rows would be one opaque tree nobody can read.
 */
class Correlation {
  private seq = 0;
  private rootId: string | null = null;
  readonly statements: string[] = [];
  // Explicit fields, not constructor parameter properties: scripts run under
  // `node --experimental-strip-types`, which is strip-only and rejects them.
  // Vitest transpiles instead, so a parameter property here passes every test
  // and then fails the moment an operator actually runs the script.
  private readonly key: string;
  private readonly operator: string;
  private readonly now: number;

  constructor(key: string, operator: string, now: number) {
    this.key = key;
    this.operator = operator;
    this.now = now;
  }

  /** @returns the new event's id, so a later consequence can name its cause. */
  event(
    family: 'roster_change' | 'board_service_change',
    kind: string,
    subjects: { table: string; column: string; id: string; role: string }[],
    reasonCode: string,
  ): string {
    const seq = this.seq;
    this.seq += 1;
    const id = derivedId('event', `${this.key}:${seq}`);
    const isRoot = seq === 0;
    if (isRoot) this.rootId = id;

    this.statements.push(
      `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, causing_event_id, actor_kind, actor_account_id, operation_key, recorded_at) ` +
        `VALUES (${quote(id)}, '${family}', ${quote(kind)}, ${quote(derivedId('correlation', this.key))}, ${seq}, ` +
        `${isRoot ? 'NULL' : quote(this.rootId)}, 'migration', ${quote(this.operator)}, ` +
        `${isRoot ? quote(`adr0022-baseline:${this.key}`) : 'NULL'}, ${this.now})`,
    );

    // Legacy facts carry no establishable day, which is exactly what the
    // `unknown` basis exists for — it is restricted to accepted legacy facts.
    // Evidence is `operator_observation`: there is no external record, and
    // naming that honestly beats dressing it up as something firmer.
    const detailTable =
      family === 'roster_change' ? 'roster_changes' : 'board_service_changes';
    this.statements.push(
      `INSERT INTO ${detailTable} (event_id, effective_day, effective_day_basis, reason_code, evidence_kind) ` +
        `VALUES (${quote(id)}, NULL, 'unknown', ${quote(reasonCode)}, 'operator_observation')`,
    );

    const subjectTable =
      family === 'roster_change'
        ? 'roster_change_subjects'
        : 'board_service_change_subjects';
    subjects.forEach((s, i) => {
      this.statements.push(
        `INSERT INTO ${subjectTable} (id, event_id, role, ${s.column}) ` +
          `VALUES (${quote(derivedId('subject', `${this.key}:${seq}:${i}`))}, ${quote(id)}, '${s.role}', ${quote(s.id)})`,
      );
    });
    return id;
  }

  get eventCount(): number {
    return this.seq;
  }
}

export function buildPlan(
  data: LegacyData,
  now: number,
  options: PlanOptions = {},
): BackfillPlan {
  const statements: string[] = [];
  // Baseline events reference domain rows with RESTRICT foreign keys, so they
  // are collected separately and appended after every domain row exists.
  const baseline: string[] = [];
  const operator = options.operatorAccountId ?? null;
  const exceptions: PlanException[] = [];
  const decisions: string[] = [];
  const add = (queue: ExceptionQueue, kind: string, detail: string) =>
    exceptions.push({ queue, kind, detail });

  const counts: PlanCounts = {
    parties: 0,
    contactMethods: 0,
    ownerships: 0,
    lotsRetired: 0,
    boardTerms: 0,
    baselineEvents: 0,
  };

  const correlate = (key: string): Correlation | null =>
    operator === null ? null : new Correlation(key, operator, now);

  const collect = (c: Correlation | null) => {
    if (!c) return;
    baseline.push(...c.statements);
    counts.baselineEvents += c.eventCount;
  };

  // -- Lots -----------------------------------------------------------------
  // There is no Lot backfill: every Lot already exists as a `properties` row
  // with its identity intact. Only retirement is recorded, and only with an
  // unknown day — `status = 'inactive'` carries no date, and stamping today
  // would assert a retirement that did not happen today.
  for (const p of data.properties) {
    const lotCorrelation = correlate(`lot:${p.id}`);
    lotCorrelation?.event(
      'roster_change',
      'lot_baseline_recorded',
      [{ table: 'properties', column: 'lot_id', id: p.id, role: 'primary' }],
      'legacy_migration_baseline',
    );
    if (p.status === 'inactive') {
      statements.push(
        `UPDATE properties SET retired_at = ${now}, retired_day = NULL WHERE id = ${quote(p.id)}`,
      );
      counts.lotsRetired += 1;
      // A caused consequence of the same command, not a separate decision.
      lotCorrelation?.event(
        'roster_change',
        'lot_retired',
        [{ table: 'properties', column: 'lot_id', id: p.id, role: 'primary' }],
        'legacy_status_inactive',
      );
    }
    collect(lotCorrelation);
    if (p.notes && p.notes.trim() !== '') {
      add(
        'advisory',
        'legacy_note',
        `property ${p.id} has a note; notes migrate nowhere and drop in phase 4`,
      );
    }
  }

  // -- Parties, Contact Methods, Ownerships ---------------------------------
  // ONE PARTY PER LEGACY OWNER ROW, with no automatic merging at any confidence
  // level: a person owning three Lots becomes three Parties. A name match is not
  // an identity match — a father and son sharing a name would be fused into one
  // Person holding both their Lots and both their authority — and consolidation
  // is deliberately an audited human act.
  const contactIndex = new Map<string, Set<string>>();
  const nameIndex = new Map<string, Set<string>>();

  for (const o of data.owners) {
    const partyId = derivedId('party', o.id);
    const nameNorm = normalizeName(o.full_name);
    const c = correlate(`party:${o.id}`);
    // The Party is the root of this correlation; its contacts and ownership
    // are caused consequences of the same accepted command.
    c?.event(
      'roster_change',
      'party_baseline_recorded',
      [{ table: 'parties', column: 'party_id', id: partyId, role: 'primary' }],
      'legacy_migration_baseline',
    );
    statements.push(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES (${quote(partyId)}, 'person', ${now}, ${now})`,
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at) VALUES (${quote(partyId)}, 'person', ${quote(o.full_name)}, ${quote(nameNorm)}, ${now})`,
    );
    counts.parties += 1;

    if (nameNorm) {
      const seen = nameIndex.get(nameNorm) ?? new Set<string>();
      seen.add(partyId);
      nameIndex.set(nameNorm, seen);
    }
    if (ORG_HINTS.test(o.full_name)) {
      add(
        'blocking',
        'organization_candidate',
        `owner ${o.id} looks organizational; confirm Person or Organization before the flip`,
      );
    }
    if (o.notes && o.notes.trim() !== '') {
      add(
        'advisory',
        'legacy_note',
        `owner ${o.id} has a note; notes migrate nowhere`,
      );
    }

    // One Contact Method per non-blank value, deduplicated WITHIN a Party and
    // never ACROSS one: a couple sharing an email must stay ambiguous, because
    // that ambiguity is exactly what bars automatic verification.
    for (const [channel, raw, normalize] of [
      ['email', o.email, normalizeEmail],
      ['sms', o.phone, normalizePhone],
    ] as const) {
      const normalized = normalize(raw);
      if (!normalized) continue;
      const contactId = derivedId(`contact:${channel}`, o.id);
      statements.push(
        // Always 'person': the backfill creates only person parties — an
        // organization candidate is a flip-blocking exception, never a row.
        `INSERT INTO contact_methods (id, party_id, party_kind, channel, value, value_normalized, is_preferred, start_day, created_at, updated_at) ` +
          `VALUES (${quote(contactId)}, ${quote(partyId)}, 'person', '${channel}', ${quote(String(raw))}, ${quote(normalized)}, 1, NULL, ${now}, ${now})`,
      );
      counts.contactMethods += 1;
      c?.event(
        'roster_change',
        'contact_method_recorded',
        [
          {
            table: 'contact_methods',
            column: 'contact_method_id',
            id: contactId,
            role: 'created',
          },
        ],
        'legacy_migration_baseline',
      );
      const key = `${channel}:${normalized}`;
      const holders = contactIndex.get(key) ?? new Set<string>();
      holders.add(partyId);
      contactIndex.set(key, holders);
    }

    // ACTIVE owners get an Ownership with an unknown start — the one legacy
    // allowance. INACTIVE owners get NO Ownership: "ended, day unknown" is
    // unrepresentable because a null end means *current*, and stamping today
    // would fabricate a fact. The former relationship is recorded in the audit
    // baseline instead. Legacy carries no dates, so no real history is lost.
    if (o.status === 'active') {
      const ownershipId = derivedId('ownership', o.id);
      statements.push(
        `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at) ` +
          `VALUES (${quote(ownershipId)}, ${quote(partyId)}, ${quote(o.property_id)}, NULL, ${now}, ${now})`,
      );
      counts.ownerships += 1;
      c?.event(
        'roster_change',
        'ownership_recorded',
        [
          {
            table: 'ownerships',
            column: 'ownership_id',
            id: ownershipId,
            role: 'created',
          },
          {
            table: 'properties',
            column: 'lot_id',
            id: o.property_id,
            role: 'related',
          },
        ],
        'legacy_migration_baseline',
      );
    } else {
      // The ONLY record that this Party once owned this Lot. No Ownership row
      // exists, because "ended, day unknown" is unrepresentable — so without
      // this event the relationship would vanish entirely.
      c?.event(
        'roster_change',
        'legacy_prior_ownership_recorded',
        [
          {
            table: 'parties',
            column: 'party_id',
            id: partyId,
            role: 'primary',
          },
          {
            table: 'properties',
            column: 'lot_id',
            id: o.property_id,
            role: 'related',
          },
        ],
        'legacy_status_inactive',
      );
    }
    collect(c);
  }

  for (const [key, holders] of contactIndex) {
    if (holders.size > 1) {
      add(
        'advisory',
        'shared_contact',
        `${key.split(':')[0]} contact shared by ${holders.size} parties — all are barred from automatic verification`,
      );
    }
  }
  for (const [, holders] of nameIndex) {
    if (holders.size > 1) {
      add(
        'advisory',
        'duplicate_candidate',
        `${holders.size} parties share a normalized name — review for consolidation after the flip`,
      );
    }
  }

  const ownedLots = new Set(
    data.owners.filter((o) => o.status === 'active').map((o) => o.property_id),
  );
  for (const p of data.properties) {
    if (p.status === 'active' && !ownedLots.has(p.id)) {
      add(
        'advisory',
        'ownerless_lot',
        `lot ${p.id} has no active owner; it stays in denominators and supplies no authority`,
      );
    }
  }

  // -- Board service --------------------------------------------------------
  // Board people get their own Person, so a sitting board member who also owns
  // their home lands as TWO Parties — the Board Term pointing at one and the
  // Ownership at the other. Reconciling them is flip-blocking, because
  // qualifying-Lot validation would otherwise fail for the most ordinary case
  // there is.
  for (const bp of data.boardPeople) {
    const partyId = derivedId('party', `board:${bp.id}`);
    const c = correlate(`board-party:${bp.id}`);
    c?.event(
      'roster_change',
      'party_baseline_recorded',
      [{ table: 'parties', column: 'party_id', id: partyId, role: 'primary' }],
      'legacy_migration_baseline',
    );
    collect(c);
    statements.push(
      `INSERT INTO parties (id, kind, created_at, updated_at) VALUES (${quote(partyId)}, 'person', ${now}, ${now})`,
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at) VALUES (${quote(partyId)}, 'person', ${quote(bp.full_name)}, ${quote(normalizeName(bp.full_name))}, ${now})`,
    );
    counts.parties += 1;

    const ownerMatch = data.owners.find(
      (o) => normalizeName(o.full_name) === normalizeName(bp.full_name),
    );
    if (ownerMatch) {
      add(
        'blocking',
        'board_person_is_owner',
        `board person ${bp.id} matches owner ${ownerMatch.id} by name; map them onto the existing owner-derived Party rather than creating a second`,
      );
    }
  }

  for (const t of data.boardTerms) {
    const personId = derivedId('party', `board:${t.person_id}`);
    if (!t.term_end) {
      // A current term needs two things legacy never recorded: a qualifying Lot,
      // and a scheduled end — the new column is NOT NULL because the bylaws run
      // terms to the following annual meeting and contain no holdover clause.
      add(
        'blocking',
        'current_board_term',
        `board term ${t.id} is current; supply a qualifying Lot and a scheduled end day before the flip`,
      );
      continue;
    }
    if (t.term_end <= t.term_start) {
      add(
        'blocking',
        'board_term_interval',
        `board term ${t.id} ends on or before it starts; correct it before the flip`,
      );
      continue;
    }
    // An ended legacy term migrates with a NULL qualifying Lot — permitted only
    // for accepted legacy rows, mirroring the legacy start-day allowance.
    const termId = derivedId('board_term', t.id);
    statements.push(
      `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, created_at, updated_at) ` +
        `VALUES (${quote(termId)}, ${quote(personId)}, NULL, ${quote(t.term_start)}, ${quote(t.term_end)}, ${now}, ${now})`,
    );
    counts.boardTerms += 1;
    const tc = correlate(`board-term:${t.id}`);
    tc?.event(
      'board_service_change',
      'board_term_baseline_recorded',
      [
        {
          table: 'board_service_terms',
          column: 'board_term_id',
          id: termId,
          role: 'primary',
        },
      ],
      'legacy_migration_baseline',
    );
    collect(tc);
    if (t.title && !mapOffice(t.title)) {
      add(
        'advisory',
        'unmapped_office',
        `board term ${t.id} has an unrecognised title; it migrates with no office`,
      );
    }
  }

  // Board Access requires a qualifying current-or-scheduled Board Term, so an
  // account holding `role = 'board'` for technical rather than governance
  // reasons has no seat in the new model except System Administration Access.
  // Both possible defaults are wrong: one invents governance authority, the
  // other hands out the strictly larger grant. The operator resolves each
  // account explicitly — a `technical` classification suppresses the exception
  // and plans nothing (see `PlanOptions.classifications`).
  const classifications = options.classifications ?? {};
  for (const a of data.boardAccounts) {
    if (classifications[a.id] === 'technical') {
      decisions.push(
        `account ${a.id} classified as technical administrator: no Board Term, no rows — ` +
          `System Administration Access arrives only via the bootstrap`,
      );
      continue;
    }
    add(
      'blocking',
      'board_account_unclassified',
      `account ${a.id} holds role='board'; classify as Board Member or technical administrator`,
    );
  }
  // A classification naming no role='board' account is a typo, and a typo that
  // silently does nothing is how the wrong account stays suppressed.
  for (const id of Object.keys(classifications)) {
    if (!data.boardAccounts.some((a) => a.id === id)) {
      add(
        'blocking',
        'classification_unmatched',
        `--classify names account ${id}, which does not hold role='board'`,
      );
    }
  }

  // Baseline last: every event names a domain row through a RESTRICT foreign
  // key, so the rows must already exist.
  const ordered = [...statements, ...baseline];
  return {
    statements:
      (options.mode ?? 'rehearsal') === 'authoritative'
        ? ordered.map(insertOnce)
        : ordered,
    exceptions,
    counts,
    decisions,
  };
}

/**
 * Rewrites one statement for insert-once (phase 3) semantics.
 *
 * `ON CONFLICT DO NOTHING` with no conflict target, deliberately NOT
 * `INSERT OR IGNORE`. The two look interchangeable and are not: `OR IGNORE`
 * also swallows CHECK and NOT NULL violations, so a malformed row would vanish
 * silently instead of failing the run. `ON CONFLICT DO NOTHING` applies only to
 * uniqueness conflicts — exactly the "this row is already here" case — and
 * leaves every other constraint loud. Foreign-key violations raise under both,
 * which is what we want.
 *
 * The retirement UPDATE is guarded rather than skipped: re-running must not
 * overwrite a retirement a human recorded properly in the meantime.
 */
function insertOnce(statement: string): string {
  if (statement.startsWith('INSERT INTO')) {
    return `${statement} ON CONFLICT DO NOTHING`;
  }
  if (statement.startsWith('UPDATE properties SET retired_at')) {
    return `${statement} AND retired_at IS NULL`;
  }
  return statement;
}

/** Children first. Rehearsal only — phase 3 is insert-once keyed by
 * `operation_key`, because once the authoritative run writes ledger rows a
 * clean replace would be deleting immutable history. */
export const CLEAN_REPLACE_STATEMENTS = [
  // Ledger first: its rows reference domain rows through RESTRICT keys.
  'DELETE FROM roster_change_subjects',
  'DELETE FROM board_service_change_subjects',
  'DELETE FROM roster_changes',
  'DELETE FROM board_service_changes',
  // `causing_event_id` is a RESTRICT self-reference and SQLite enforces foreign
  // keys per row, so a bare `DELETE FROM audit_events` fails the moment it
  // reaches a cause something still points at. Consequences go first.
  'DELETE FROM audit_events WHERE causing_event_id IS NOT NULL',
  'DELETE FROM audit_events',
  'DELETE FROM board_office_assignments',
  'DELETE FROM board_service_terms',
  'DELETE FROM representation_lots',
  'DELETE FROM representations',
  'DELETE FROM ownerships',
  'DELETE FROM contact_methods',
  'DELETE FROM organizations',
  'DELETE FROM people',
  'DELETE FROM parties',
];
