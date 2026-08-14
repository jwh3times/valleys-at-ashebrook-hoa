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
}

export interface BackfillPlan {
  statements: string[];
  exceptions: PlanException[];
  counts: PlanCounts;
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

export function buildPlan(data: LegacyData, now: number): BackfillPlan {
  const statements: string[] = [];
  const exceptions: PlanException[] = [];
  const add = (queue: ExceptionQueue, kind: string, detail: string) =>
    exceptions.push({ queue, kind, detail });

  const counts: PlanCounts = {
    parties: 0,
    contactMethods: 0,
    ownerships: 0,
    lotsRetired: 0,
    boardTerms: 0,
  };

  // -- Lots -----------------------------------------------------------------
  // There is no Lot backfill: every Lot already exists as a `properties` row
  // with its identity intact. Only retirement is recorded, and only with an
  // unknown day — `status = 'inactive'` carries no date, and stamping today
  // would assert a retirement that did not happen today.
  for (const p of data.properties) {
    if (p.status === 'inactive') {
      statements.push(
        `UPDATE properties SET retired_at = ${now}, retired_day = NULL WHERE id = ${quote(p.id)}`,
      );
      counts.lotsRetired += 1;
    }
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
      statements.push(
        `INSERT INTO contact_methods (id, party_id, channel, value, value_normalized, is_preferred, start_day, created_at, updated_at) ` +
          `VALUES (${quote(derivedId(`contact:${channel}`, o.id))}, ${quote(partyId)}, '${channel}', ${quote(String(raw))}, ${quote(normalized)}, 1, NULL, ${now}, ${now})`,
      );
      counts.contactMethods += 1;
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
      statements.push(
        `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at) ` +
          `VALUES (${quote(derivedId('ownership', o.id))}, ${quote(partyId)}, ${quote(o.property_id)}, NULL, ${now}, ${now})`,
      );
      counts.ownerships += 1;
    }
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
    statements.push(
      `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, created_at, updated_at) ` +
        `VALUES (${quote(derivedId('board_term', t.id))}, ${quote(personId)}, NULL, ${quote(t.term_start)}, ${quote(t.term_end)}, ${now}, ${now})`,
    );
    counts.boardTerms += 1;
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
  // other hands out the strictly larger grant.
  for (const a of data.boardAccounts) {
    add(
      'blocking',
      'board_account_unclassified',
      `account ${a.id} holds role='board'; classify as Board Member or technical administrator`,
    );
  }

  return { statements, exceptions, counts };
}

/** Children first. Rehearsal only — phase 3 is insert-once keyed by
 * `operation_key`, because once the authoritative run writes ledger rows a
 * clean replace would be deleting immutable history. */
export const CLEAN_REPLACE_TABLES = [
  'board_office_assignments',
  'board_service_terms',
  'representation_lots',
  'representations',
  'ownerships',
  'contact_methods',
  'organizations',
  'people',
  'parties',
];
