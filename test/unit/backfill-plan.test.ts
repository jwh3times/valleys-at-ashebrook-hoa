import { describe, it, expect } from 'vitest';
import {
  buildPlan,
  derivedId,
  mapOffice,
  type LegacyData,
} from '../../scripts/backfill-plan';

// ADR 0022 roster backfill mapping rules (issue #210).
//
// The rules are tested against synthetic legacy data rather than by running the
// migration, because a migration whose rules are only exercised against
// production is a migration nobody can review.

const NOW = 1_700_000_000_000;

function legacy(overrides: Partial<LegacyData> = {}): LegacyData {
  return {
    properties: [],
    owners: [],
    boardPeople: [],
    boardTerms: [],
    boardAccounts: [],
    ...overrides,
  };
}

const owner = (
  id: string,
  propertyId: string,
  overrides: Partial<LegacyData['owners'][number]> = {},
) => ({
  id,
  property_id: propertyId,
  full_name: 'Jane Doe',
  status: 'active',
  ...overrides,
});

const blocking = (plan: ReturnType<typeof buildPlan>, kind: string) =>
  plan.exceptions.filter((e) => e.queue === 'blocking' && e.kind === kind);
const advisory = (plan: ReturnType<typeof buildPlan>, kind: string) =>
  plan.exceptions.filter((e) => e.queue === 'advisory' && e.kind === kind);

describe('derived ids', () => {
  it('are stable across runs and distinct per kind', () => {
    // Stability is what lets the phase-3 insert-once run share this code path
    // with the phase-2 clean-replace rehearsal.
    expect(derivedId('party', 'o1')).toBe(derivedId('party', 'o1'));
    expect(derivedId('party', 'o1')).not.toBe(derivedId('ownership', 'o1'));
    expect(derivedId('party', 'o1')).not.toBe(derivedId('party', 'o2'));
  });

  it('do not leak the legacy id', () => {
    expect(derivedId('party', 'secret-legacy-id')).not.toContain('secret');
  });
});

describe('parties are never merged', () => {
  it('creates one party per legacy owner row, even for the same person', () => {
    // A person owning three Lots is three rows today and becomes three
    // Parties. A name match is not an identity match.
    const plan = buildPlan(
      legacy({
        properties: [
          { id: 'lot-1', status: 'active' },
          { id: 'lot-2', status: 'active' },
        ],
        owners: [
          owner('o1', 'lot-1', { full_name: 'Jane Doe' }),
          owner('o2', 'lot-2', { full_name: 'Jane Doe' }),
        ],
      }),
      NOW,
    );
    expect(plan.counts.parties).toBe(2);
    expect(plan.counts.ownerships).toBe(2);
    // Reported for human review, never merged automatically.
    expect(advisory(plan, 'duplicate_candidate')).toHaveLength(1);
  });
});

describe('inactive legacy rows', () => {
  it('gives an inactive owner a party but no ownership', () => {
    // "Ended, day unknown" is unrepresentable — a null end means current — and
    // stamping the migration day would fabricate a fact.
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [owner('o1', 'lot-1', { status: 'inactive' })],
      }),
      NOW,
    );
    expect(plan.counts.parties).toBe(1);
    expect(plan.counts.ownerships).toBe(0);
    expect(
      plan.statements.some((s) => s.includes('INSERT INTO ownerships')),
    ).toBe(false);
  });

  it('retires an inactive lot with an unknown day', () => {
    const plan = buildPlan(
      legacy({ properties: [{ id: 'lot-1', status: 'inactive' }] }),
      NOW,
    );
    expect(plan.counts.lotsRetired).toBe(1);
    const update = plan.statements.find((s) =>
      s.startsWith('UPDATE properties'),
    );
    expect(update).toContain('retired_day = NULL');
    expect(update).toContain(`retired_at = ${NOW}`);
  });
});

describe('contact ambiguity is preserved, not tidied away', () => {
  it('flags one email shared across two parties', () => {
    // The ambiguity is exactly what must bar automatic verification, so both
    // owners keep their contact and the pair is reported.
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [
          owner('o1', 'lot-1', { email: 'HOUSE@example.com' }),
          owner('o2', 'lot-1', {
            email: 'house@example.COM',
            full_name: 'John Doe',
          }),
        ],
      }),
      NOW,
    );
    expect(plan.counts.contactMethods).toBe(2);
    expect(advisory(plan, 'shared_contact')).toHaveLength(1);
  });

  it('normalizes at migration time so two spellings of one number collide', () => {
    // Legacy values are not consistently normalized: E.164 coercion happens
    // only in the import script, while the admin path merely trims.
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [
          owner('o1', 'lot-1', { phone: '(555) 010-1234' }),
          owner('o2', 'lot-1', {
            phone: '555-010-1234',
            full_name: 'John Doe',
          }),
        ],
      }),
      NOW,
    );
    expect(advisory(plan, 'shared_contact')).toHaveLength(1);
  });

  it('does not flag distinct contacts', () => {
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [
          owner('o1', 'lot-1', { email: 'a@example.com' }),
          owner('o2', 'lot-1', {
            email: 'b@example.com',
            full_name: 'John Doe',
          }),
        ],
      }),
      NOW,
    );
    expect(advisory(plan, 'shared_contact')).toHaveLength(0);
  });
});

describe('organization detection blocks rather than classifies', () => {
  it('defaults an entity-looking owner to Person and raises a blocking exception', () => {
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [owner('o1', 'lot-1', { full_name: 'Ashebrook Holdings LLC' })],
      }),
      NOW,
    );
    // Still written as a Person — the heuristic's job is to make a human look.
    expect(plan.statements.some((s) => s.includes("'person'"))).toBe(true);
    expect(
      plan.statements.some((s) => s.includes('INSERT INTO organizations')),
    ).toBe(false);
    expect(blocking(plan, 'organization_candidate')).toHaveLength(1);
  });

  it('does not fire on ordinary surnames that contain the hint letters', () => {
    // Word boundaries matter: a substring match on `co`, `lp`, or `inc` hits
    // Cooper, Alpert, and Vince.
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [
          owner('o1', 'lot-1', { full_name: 'Vince Cooper' }),
          owner('o2', 'lot-1', { full_name: 'Sandra Alpert' }),
        ],
      }),
      NOW,
    );
    expect(blocking(plan, 'organization_candidate')).toHaveLength(0);
  });
});

describe('board service', () => {
  it('blocks a current term, which legacy never gave a scheduled end', () => {
    const plan = buildPlan(
      legacy({
        boardPeople: [{ id: 'bp1', full_name: 'Alex Board' }],
        boardTerms: [
          {
            id: 't1',
            person_id: 'bp1',
            term_start: '2026-01-01',
            term_end: null,
          },
        ],
      }),
      NOW,
    );
    expect(blocking(plan, 'current_board_term')).toHaveLength(1);
    expect(plan.counts.boardTerms).toBe(0);
  });

  it('migrates an ended term with no qualifying lot', () => {
    const plan = buildPlan(
      legacy({
        boardPeople: [{ id: 'bp1', full_name: 'Alex Board' }],
        boardTerms: [
          {
            id: 't1',
            person_id: 'bp1',
            term_start: '2024-01-01',
            term_end: '2025-01-01',
          },
        ],
      }),
      NOW,
    );
    expect(plan.counts.boardTerms).toBe(1);
    const insert = plan.statements.find((s) =>
      s.includes('INSERT INTO board_service_terms'),
    );
    // NULL is legal only for accepted legacy rows that have already ended.
    expect(insert).toContain('NULL');
  });

  it('blocks a board person who is also an owner', () => {
    // Otherwise the Board Term points at one Party and the Ownership at
    // another, and qualifying-Lot validation fails for the most ordinary case.
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [owner('o1', 'lot-1', { full_name: 'Alex Board' })],
        boardPeople: [{ id: 'bp1', full_name: 'Alex Board' }],
      }),
      NOW,
    );
    expect(blocking(plan, 'board_person_is_owner')).toHaveLength(1);
  });

  it('blocks every legacy board account until it is classified', () => {
    const plan = buildPlan(
      legacy({ boardAccounts: [{ id: 'acct-1' }, { id: 'acct-2' }] }),
      NOW,
    );
    expect(blocking(plan, 'board_account_unclassified')).toHaveLength(2);
  });
});

describe('office mapping', () => {
  it('maps the bylaws offices and refuses to guess', () => {
    expect(mapOffice('President')).toBe('president');
    expect(mapOffice('Vice-Pres.')).toBe('vice_president');
    expect(mapOffice('Secretary/Treasurer')).toBe('secretary_treasurer');
    expect(mapOffice('Member at Large')).toBeNull();
    expect(mapOffice(null)).toBeNull();
  });

  it('reports an unmapped title rather than dropping it silently', () => {
    const plan = buildPlan(
      legacy({
        boardPeople: [{ id: 'bp1', full_name: 'Alex Board' }],
        boardTerms: [
          {
            id: 't1',
            person_id: 'bp1',
            title: 'Member at Large',
            term_start: '2024-01-01',
            term_end: '2025-01-01',
          },
        ],
      }),
      NOW,
    );
    expect(advisory(plan, 'unmapped_office')).toHaveLength(1);
  });
});

describe('abandoned legacy data', () => {
  it('never emits a person link or verification', () => {
    // Property links are abandoned, not converted — including the unambiguous
    // single-owner case. A link proves someone held a contact on file, which is
    // weaker than "this account is that person".
    const plan = buildPlan(
      legacy({
        properties: [{ id: 'lot-1', status: 'active' }],
        owners: [owner('o1', 'lot-1')],
      }),
      NOW,
    );
    const sql = plan.statements.join('\n');
    expect(sql).not.toContain('person_links');
    expect(sql).not.toContain('person_verifications');
    expect(sql).not.toContain('access_grants');
  });

  it('carries no legacy note into any table, and reports each one', () => {
    const plan = buildPlan(
      legacy({
        properties: [
          { id: 'lot-1', status: 'active', notes: 'gate code 1234' },
        ],
        owners: [owner('o1', 'lot-1', { notes: 'prefers email' })],
      }),
      NOW,
    );
    const sql = plan.statements.join('\n');
    expect(sql).not.toContain('gate code');
    expect(sql).not.toContain('prefers email');
    expect(advisory(plan, 'legacy_note')).toHaveLength(2);
  });

  it('reports an ownerless lot without blocking', () => {
    const plan = buildPlan(
      legacy({ properties: [{ id: 'lot-1', status: 'active' }] }),
      NOW,
    );
    expect(advisory(plan, 'ownerless_lot')).toHaveLength(1);
    expect(plan.exceptions.filter((e) => e.queue === 'blocking')).toHaveLength(
      0,
    );
  });
});
