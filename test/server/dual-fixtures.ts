import { env } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';

// ONE declarative description, emitting BOTH shapes (issue #210, phase 2).
//
// The obvious alternative — a legacy builder plus a new-model builder — quietly
// breaks the parity suite. Two independent builders let the two models be set
// up from subtly different worlds, and the suite would then compare two
// different setups and report agreement: a green test proving nothing, which is
// worse than no test because it retires the question.
//
// So a spec here says "this Lot, these owners, this account verified against
// it" once, and both models are written from that single statement of fact.
//
// The legacy half is deleted in phase 4; the description format stays.

export interface OwnerSpec {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  /** Legacy `owners.status`. An inactive owner gets no Ownership in the new
   * model — "ended, day unknown" is unrepresentable. */
  active?: boolean;
}

export interface LotSpec {
  id: string;
  owners: OwnerSpec[];
  retired?: boolean;
}

export interface AccountSpec {
  id: string;
  /** Legacy `users.role`. */
  role?: 'visitor' | 'homeowner' | 'board' | null;
  /** Legacy `user_property_links` rows. */
  legacyLots?: string[];
  /** New-model Person Link. Omit to leave the account unlinked, which is the
   * accepted mass re-verification case. */
  linkedTo?: string;
  /** New-model access grants. A board grant needs a term; see `boardTerm`. */
  grants?: ('board' | 'system_admin')[];
  /** Creates a board service term for the linked Person and qualifies a board
   * grant with it. */
  boardTerm?: { startDay: string; scheduledEndDay: string; lotId?: string };
}

export interface RosterSpec {
  lots?: LotSpec[];
  accounts?: AccountSpec[];
}

const db = () => getDb(env);
const q = (v: string | null | undefined) =>
  v === null || v === undefined ? 'NULL' : `'${v.replace(/'/g, "''")}'`;

const NEW_TABLES = [
  'cutover_shadow_mismatches',
  'access_grants',
  'board_office_assignments',
  'board_service_terms',
  'person_links',
  'person_verifications',
  'representation_lots',
  'representations',
  'ownerships',
  'contact_methods',
  'organizations',
  'people',
  'parties',
];

const LEGACY_TABLES = ['user_property_links', 'owners', 'properties'];

export async function resetRoster(): Promise<void> {
  for (const table of [...NEW_TABLES, ...LEGACY_TABLES]) {
    await db().run(sql.raw(`DELETE FROM "${table}"`));
  }
}

/** Writes the spec into both models. */
export async function seedRoster(spec: RosterSpec): Promise<void> {
  const statements: string[] = [];
  const now = 1;

  for (const lot of spec.lots ?? []) {
    // The Lot IS `properties` — there is no separate lots table, and no Lot
    // backfill, because every Lot already exists with its identity intact.
    statements.push(
      `INSERT INTO properties (id, address, address_normalized, status, vote_weight, retired_at, created_at, updated_at)
       VALUES (${q(lot.id)}, ${q(`${lot.id} Way`)}, ${q(`${lot.id} way`)},
               ${lot.retired ? "'inactive'" : "'active'"}, 1, ${lot.retired ? 99 : 'NULL'}, ${now}, ${now})`,
    );

    for (const owner of lot.owners) {
      const active = owner.active ?? true;
      // Legacy shape.
      statements.push(
        `INSERT INTO owners (id, property_id, full_name, phone, email, status, created_at, updated_at)
         VALUES (${q(owner.id)}, ${q(lot.id)}, ${q(owner.name)}, ${q(owner.phone)}, ${q(owner.email)},
                 ${active ? "'active'" : "'inactive'"}, ${now}, ${now})`,
      );
      // New shape: one Party per owner row, never merged.
      statements.push(
        `INSERT INTO parties (id, kind, created_at, updated_at) VALUES (${q(owner.id)}, 'person', ${now}, ${now})`,
        `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
         VALUES (${q(owner.id)}, 'person', ${q(owner.name)}, ${q(owner.name.toLowerCase())}, ${now})`,
      );
      if (owner.email) {
        statements.push(
          `INSERT INTO contact_methods (id, party_id, party_kind, channel, value, value_normalized, is_preferred, created_at, updated_at)
           VALUES (${q(`${owner.id}-email`)}, ${q(owner.id)}, 'person', 'email', ${q(owner.email)}, ${q(owner.email.toLowerCase())}, 1, ${now}, ${now})`,
        );
      }
      if (active) {
        statements.push(
          `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
           VALUES (${q(`${owner.id}-own`)}, ${q(owner.id)}, ${q(lot.id)}, NULL, ${now}, ${now})`,
        );
      }
    }
  }

  for (const account of spec.accounts ?? []) {
    statements.push(
      `INSERT INTO users (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (${q(account.id)}, ${q(account.id)}, ${q(`${account.id}@example.test`)}, 0,
               ${account.role === undefined ? 'NULL' : q(account.role)}, ${now}, ${now})`,
    );

    for (const lotId of account.legacyLots ?? []) {
      statements.push(
        `INSERT INTO user_property_links (id, user_id, property_id, verified_at, method)
         VALUES (${q(`${account.id}-${lotId}`)}, ${q(account.id)}, ${q(lotId)}, ${now}, 'otp_email')`,
      );
    }

    if (account.linkedTo) {
      statements.push(
        `INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
         VALUES (${q(`${account.id}-ver`)}, ${q(account.id)}, ${q(account.linkedTo)}, 'manual', ${q(account.id)}, 'manual_board_decision', ${now})`,
        `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
         VALUES (${q(`${account.id}-link`)}, ${q(account.id)}, ${q(account.linkedTo)}, ${q(`${account.id}-ver`)}, ${now})`,
      );
    }

    const termId = `${account.id}-term`;
    if (account.boardTerm && account.linkedTo) {
      statements.push(
        `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, created_at, updated_at)
         VALUES (${q(termId)}, ${q(account.linkedTo)}, ${q(account.boardTerm.lotId)},
                 ${q(account.boardTerm.startDay)}, ${q(account.boardTerm.scheduledEndDay)}, ${now}, ${now})`,
      );
    }
    for (const grant of account.grants ?? []) {
      statements.push(
        `INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at)
         VALUES (${q(`${account.id}-${grant}`)}, ${q(account.id)}, ${q(grant)},
                 ${grant === 'board' ? q(termId) : 'NULL'}, ${now})`,
      );
    }
  }

  for (const statement of statements) {
    await db().run(sql.raw(statement));
  }
}

/**
 * The legacy authorization answer, read from the legacy tables.
 *
 * Mirrors `getAuthContext`'s two facts — the stored role, coerced to visitor
 * for anything unrecognised, and the links joined to ACTIVE properties — without
 * needing a session. Session plumbing is not what the parity suite is testing.
 */
export async function legacyContext(
  accountId: string,
): Promise<{ role: 'visitor' | 'homeowner' | 'board'; propertyIds: string[] }> {
  const rows = await db().all<{ role: string | null }>(
    sql`SELECT role FROM users WHERE id = ${accountId}`,
  );
  const raw = rows[0]?.role;
  const role =
    raw === 'homeowner' || raw === 'board' ? raw : ('visitor' as const);
  const links = await db().all<{ property_id: string }>(
    sql`SELECT l.property_id FROM user_property_links l
        JOIN properties p ON p.id = l.property_id AND p.status = 'active'
        WHERE l.user_id = ${accountId}`,
  );
  return { role, propertyIds: links.map((l) => l.property_id) };
}
