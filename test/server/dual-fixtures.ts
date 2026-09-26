import { env } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';

// One declarative roster fixture: Lots, Persons, relationships, and grants.

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
  'access_grants',
  'board_office_assignments',
  'board_terms',
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

const LOT_TABLES = ['lots'];

export async function resetRoster(): Promise<void> {
  for (const table of [...NEW_TABLES, ...LOT_TABLES]) {
    await db().run(sql.raw(`DELETE FROM "${table}"`));
  }
}

/** Writes the declarative spec into the permanent roster. */
export async function seedRoster(spec: RosterSpec): Promise<void> {
  const statements: string[] = [];
  const now = 1;

  for (const lot of spec.lots ?? []) {
    statements.push(
      `INSERT INTO lots (id, address, address_normalized, status, vote_weight, retired_at, created_at, updated_at)
       VALUES (${q(lot.id)}, ${q(`${lot.id} Way`)}, ${q(`${lot.id} way`)},
               ${lot.retired ? "'inactive'" : "'active'"}, 1, ${lot.retired ? 99 : 'NULL'}, ${now}, ${now})`,
    );

    for (const owner of lot.owners) {
      const active = owner.active ?? true;
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
        `INSERT INTO board_terms (id, person_id, qualifying_lot_id, start_day, scheduled_end_day, created_at, updated_at)
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
