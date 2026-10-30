// Shared roster builders (#294 slice 3). The board's roster routes and Tenancy
// approval both record People and Contact Methods; these are the one copy of
// each so the two paths cannot drift.

import { CONTACT_INPUT_LIMITS } from '../../lib/types';
import { normalizeEmail, normalizeName, normalizePhone } from './normalize';
import {
  insertedRowGuard,
  type AuditCorrelation,
  type Evidence,
  type RosterChangeReason,
  type SqlGuard,
} from './audit';

/**
 * A NEW contact value's normalized form, or why it was refused.
 *
 * The shared normalizers deliberately do NOT validate — legacy values are
 * accepted as recorded — so a light shape check and the channel's length cap
 * live here, where someone is typing a new value and a typo should bounce
 * rather than be enshrined. Only new values pass through, so the cap never
 * refuses a value already on file.
 */
export function normalizedContactValue(
  channel: 'email' | 'sms',
  value: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const limit = CONTACT_INPUT_LIMITS[channel];
  if (value.length > limit)
    return { ok: false, error: `value must be ${limit} characters or fewer` };
  const shapeOk =
    channel === 'email'
      ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
      : value.replace(/\D/g, '').length >= 10;
  const normalized = shapeOk
    ? channel === 'email'
      ? normalizeEmail(value)
      : normalizePhone(value)
    : null;
  if (!normalized)
    return {
      ok: false,
      error:
        channel === 'email' ? 'Invalid email address' : 'Invalid phone number',
    };
  return { ok: true, value: normalized };
}

const ALWAYS: SqlGuard = { sql: '1', binds: [] };

/** `normalizeName` is nullable for blank input; names reaching these builders
 * are validated non-blank first, so the fallback only guards the type. */
const normalizedName = (name: string): string =>
  normalizeName(name) ?? name.toLowerCase();

export interface RecordPersonInput {
  id: string;
  fullName: string;
  nowMs: number;
  effectiveDay: string;
  reason: RosterChangeReason;
  evidence: Evidence;
  /** Writes the Person only while this holds; a command whose own checks
   * fail then records nothing. Omit for an unconditional write. */
  guard?: SqlGuard;
}

/**
 * Records a new Person: the Party and its subtype row in one batch, since
 * SQLite cannot enforce the parent-to-child direction, plus its
 * `person_created` event on the caller's correlation. The name reaches the
 * ledger as a category only.
 */
export function recordPerson(
  database: D1Database,
  correlation: AuditCorrelation,
  input: RecordPersonInput,
): D1PreparedStatement[] {
  const guard = input.guard ?? ALWAYS;
  correlation.event({
    kind: 'person_created',
    guard: insertedRowGuard('parties', input.id),
    sensitive: ['person_name'],
    detail: {
      family: 'roster_change',
      effective: { day: input.effectiveDay },
      reason: input.reason,
      evidence: input.evidence,
      subjects: [{ column: 'party_id', id: input.id, role: 'created' }],
    },
  });
  return [
    database
      .prepare(
        `INSERT INTO parties (id, kind, created_at, updated_at)
         SELECT ?, 'person', ?, ? WHERE ${guard.sql}`,
      )
      .bind(input.id, input.nowMs, input.nowMs, ...guard.binds),
    database
      .prepare(
        `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
         SELECT ?, 'person', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM parties WHERE id = ? AND kind = 'person')`,
      )
      .bind(
        input.id,
        input.fullName,
        normalizedName(input.fullName),
        input.nowMs,
        input.id,
      ),
  ];
}

export interface RecordContactMethodInput {
  id: string;
  partyId: string;
  channel: 'email' | 'sms';
  /** As typed. */
  value: string;
  /** From `normalizedContactValue`. */
  valueNormalized: string;
  isPreferred: boolean;
  startDay: string | null;
  nowMs: number;
  effectiveDay: string;
  reason: RosterChangeReason;
  evidence: Evidence;
  /** As for `recordPerson`. */
  guard?: SqlGuard;
}

/**
 * Records a Contact Method on an unconsolidated Party, plus its
 * `contact_method_recorded` event. The ledger records the CATEGORY (email or
 * phone), never the value. Setting `isPreferred` is the caller's business: a
 * Party with a preferred method on the channel must clear it in the same
 * batch first, or the partial unique refuses this insert.
 */
export function recordContactMethod(
  database: D1Database,
  correlation: AuditCorrelation,
  input: RecordContactMethodInput,
): D1PreparedStatement {
  const guard = input.guard ?? ALWAYS;
  correlation.event({
    kind: 'contact_method_recorded',
    guard: insertedRowGuard('contact_methods', input.id),
    sensitive: [input.channel === 'email' ? 'email' : 'phone'],
    detail: {
      family: 'roster_change',
      effective: { day: input.effectiveDay },
      reason: input.reason,
      evidence: input.evidence,
      subjects: [
        { column: 'contact_method_id', id: input.id, role: 'created' },
        { column: 'party_id', id: input.partyId, role: 'related' },
      ],
    },
  });
  // `party_kind` comes from the party row itself, so the denormalized
  // discriminator (migration 0026) can never disagree with the party.
  return database
    .prepare(
      `INSERT INTO contact_methods (id, party_id, party_kind, channel, value, value_normalized, is_preferred, start_day, created_at, updated_at)
       SELECT ?, ?, kind, ?, ?, ?, ?, ?, ?, ?
       FROM parties WHERE id = ? AND consolidated_into_party_id IS NULL
         AND ${guard.sql}`,
    )
    .bind(
      input.id,
      input.partyId,
      input.channel,
      input.value,
      input.valueNormalized,
      input.isPreferred ? 1 : 0,
      input.startDay,
      input.nowMs,
      input.nowMs,
      input.partyId,
      ...guard.binds,
    );
}
