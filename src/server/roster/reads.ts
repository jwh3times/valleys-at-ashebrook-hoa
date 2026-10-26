// Read assembly for the ADR 0022 phase-3b roster surfaces (#218): the
// board-only Roster / Board / Access reads and the member self-read.
//
// Privacy boundaries live HERE, as lots of the reads themselves:
//
//  - Contact Method values are board-and-above, plus a member's OWN methods on
//    the self-read. No member-reachable shape carries another party's contact
//    value, and the proxy picker never did (#205's system-wide ceiling).
//  - A redacted identity renders through `personDisplayLabel` — the identical
//    durable-ID fallback for every viewer, board included. No read in this
//    module returns a raw `full_name` column; they all pass through the label.
//  - Composition warnings and Ownerless Lots are LIVE-DERIVED advisories,
//    never Review Flags (#203, #205): a continuous state an unrelated later
//    action silently fixes must not leave a graveyard of open rows.

import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { lots as lotsTable } from '../db/schema';
import { users } from '../db/auth-schema';
import {
  parties,
  people,
  organizations,
  contactMethods,
  ownerships,
  representations,
  representationLots,
  boardTerms,
  boardOfficeAssignments,
  accessGrants,
  correctionRequests,
} from '../db/roster-schema';
import { maskContact, personDisplayLabel } from '../../lib/format';
import type { MemberTenancyLot } from '../../lib/types';
import { normalizeName } from './normalize';
import { basisCurrentSql, tenancyCurrentSql } from './tenancy';

export const OFFICES = [
  'president',
  'vice_president',
  'secretary_treasurer',
] as const;
export type Office = (typeof OFFICES)[number];

const toMs = (value: Date | null): number | null =>
  value ? value.getTime() : null;

/** [start, end) currency for day intervals; NULL start reads as -infinity. */
const dayCurrent = (
  startDay: string | null,
  endDay: string | null,
  day: string,
): boolean =>
  (startDay === null || startDay <= day) && (endDay === null || day < endDay);

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface RosterLotRow {
  id: string;
  platLotNumber: string | null;
  address: string;
  unit: string | null;
  voteWeight: number;
  retiredDay: string | null;
  retiredAt: number | null;
  /** Live-derived: unretired with no current Ownership. */
  ownerless: boolean;
}

export interface RosterPersonRow {
  partyId: string;
  /** Real name or the durable-ID redaction fallback — never null. */
  displayName: string;
  nameRedacted: boolean;
  consolidatedIntoPartyId: string | null;
}

export interface RosterOrganizationRow {
  partyId: string;
  legalName: string;
  displayName: string | null;
  consolidatedIntoPartyId: string | null;
}

export interface RosterOwnershipRow {
  id: string;
  ownerPartyId: string;
  lotId: string;
  startDay: string | null;
  endDay: string | null;
  voided: boolean;
  current: boolean;
}

export interface RosterRepresentationRow {
  id: string;
  representativePersonId: string;
  organizationPartyId: string;
  scopeKind: 'organization' | 'lots';
  scopeLotIds: string[];
  startDay: string;
  endDay: string | null;
  voided: boolean;
  current: boolean;
}

export interface RosterContactMethodRow {
  id: string;
  partyId: string;
  channel: 'email' | 'sms';
  /** Board-and-above read: the value, or null when redacted. */
  value: string | null;
  redacted: boolean;
  isPreferred: boolean;
  startDay: string | null;
  endDay: string | null;
  voided: boolean;
}

export interface AdminRoster {
  lots: RosterLotRow[];
  people: RosterPersonRow[];
  organizations: RosterOrganizationRow[];
  ownerships: RosterOwnershipRow[];
  representations: RosterRepresentationRow[];
  contactMethods: RosterContactMethodRow[];
  advisories: { ownerlessLotIds: string[] };
}

export async function fetchAdminRoster(
  env: Env,
  associationDay: string,
): Promise<AdminRoster> {
  const db = getDb(env);
  const [
    lotRows,
    personRows,
    orgRows,
    ownershipRows,
    repRows,
    repLotRows,
    contactRows,
  ] = await Promise.all([
    db.select().from(lotsTable).orderBy(asc(lotsTable.address)),
    db
      .select({
        partyId: people.partyId,
        fullName: people.fullName,
        nameRedactedAt: people.nameRedactedAt,
        consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
      })
      .from(people)
      .innerJoin(parties, eq(parties.id, people.partyId)),
    db
      .select({
        partyId: organizations.partyId,
        legalName: organizations.legalName,
        displayName: organizations.displayName,
        consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
      })
      .from(organizations)
      .innerJoin(parties, eq(parties.id, organizations.partyId)),
    db.select().from(ownerships),
    db.select().from(representations),
    db.select().from(representationLots),
    db.select().from(contactMethods),
  ]);

  const scopeLots = new Map<string, string[]>();
  for (const rl of repLotRows) {
    if (rl.voidedAt) continue;
    const list = scopeLots.get(rl.representationId) ?? [];
    list.push(rl.lotId);
    scopeLots.set(rl.representationId, list);
  }

  const currentlyOwnedLots = new Set(
    ownershipRows
      .filter(
        (o) => !o.voidedAt && dayCurrent(o.startDay, o.endDay, associationDay),
      )
      .map((o) => o.lotId),
  );

  const lots: RosterLotRow[] = lotRows.map((p) => ({
    id: p.id,
    platLotNumber: p.platLotNumber,
    address: p.address,
    unit: p.unit,
    voteWeight: p.voteWeight,
    retiredDay: p.retiredDay,
    retiredAt: toMs(p.retiredAt),
    ownerless: p.retiredAt === null && !currentlyOwnedLots.has(p.id),
  }));

  return {
    lots,
    people: personRows.map((p) => ({
      partyId: p.partyId,
      displayName: personDisplayLabel(p.fullName, p.partyId),
      nameRedacted: p.nameRedactedAt !== null,
      consolidatedIntoPartyId: p.consolidatedIntoPartyId,
    })),
    organizations: orgRows.map((o) => ({
      partyId: o.partyId,
      legalName: o.legalName,
      displayName: o.displayName,
      consolidatedIntoPartyId: o.consolidatedIntoPartyId,
    })),
    ownerships: ownershipRows.map((o) => ({
      id: o.id,
      ownerPartyId: o.ownerPartyId,
      lotId: o.lotId,
      startDay: o.startDay,
      endDay: o.endDay,
      voided: o.voidedAt !== null,
      current: !o.voidedAt && dayCurrent(o.startDay, o.endDay, associationDay),
    })),
    representations: repRows.map((r) => ({
      id: r.id,
      representativePersonId: r.representativePersonId,
      organizationPartyId: r.organizationPartyId,
      scopeKind: r.scopeKind,
      scopeLotIds: scopeLots.get(r.id) ?? [],
      startDay: r.startDay,
      endDay: r.endDay,
      voided: r.voidedAt !== null,
      current: !r.voidedAt && dayCurrent(r.startDay, r.endDay, associationDay),
    })),
    contactMethods: contactRows.map((c) => ({
      id: c.id,
      partyId: c.partyId,
      channel: c.channel,
      value: c.value,
      redacted: c.redactedAt !== null,
      isPreferred: c.isPreferred,
      startDay: c.startDay,
      endDay: c.endDay,
      voided: c.voidedAt !== null,
    })),
    advisories: {
      ownerlessLotIds: lots.filter((l) => l.ownerless).map((l) => l.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Tenancies (ADR 0028)
// ---------------------------------------------------------------------------

export type TenancyStatus = 'current' | 'upcoming' | 'ended' | 'voided';

export interface AdminTenancyRow {
  id: string;
  tenantPersonId: string;
  tenantName: string;
  lotId: string;
  address: string;
  startDay: string;
  scheduledEndDay: string;
  actualEndDay: string | null;
  endReason: string | null;
  renewsTenancyId: string | null;
  status: TenancyStatus;
}

/**
 * Every Tenancy, for the board's Tenants panel. Status comes from the one
 * currency rule in SQL, so the panel and derivation cannot disagree about who
 * is a tenant today. `upcoming` is the same rule asked on the start day: a
 * Tenancy whose basis ends before it begins reads as ended, not upcoming.
 *
 * Board-only, reachable only from the `requireBoard`-gated route. The name
 * passes through `personDisplayLabel` like every roster read.
 */
export async function fetchAdminTenancies(
  env: Env,
  associationDay: string,
): Promise<AdminTenancyRow[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT t.id, t.tenant_person_id, p.full_name, t.lot_id, l.address,
            t.start_day, t.scheduled_end_day, t.actual_end_day, t.end_reason,
            t.renews_tenancy_id,
            CASE
              WHEN t.voided_at IS NOT NULL THEN 'voided'
              WHEN ${tenancyCurrentSql('t', '?1')} THEN 'current'
              WHEN t.start_day > ?1 AND ${tenancyCurrentSql('t', 't.start_day')}
                THEN 'upcoming'
              ELSE 'ended'
            END AS status
     FROM tenancies t
     JOIN people p ON p.party_id = t.tenant_person_id
     JOIN lots l ON l.id = t.lot_id
     ORDER BY l.address, t.start_day DESC, t.id`,
  )
    .bind(associationDay)
    .all<{
      id: string;
      tenant_person_id: string;
      full_name: string | null;
      lot_id: string;
      address: string;
      start_day: string;
      scheduled_end_day: string;
      actual_end_day: string | null;
      end_reason: string | null;
      renews_tenancy_id: string | null;
      status: TenancyStatus;
    }>();
  return results.map((r) => ({
    id: r.id,
    tenantPersonId: r.tenant_person_id,
    tenantName: personDisplayLabel(r.full_name, r.tenant_person_id),
    lotId: r.lot_id,
    address: r.address,
    startDay: r.start_day,
    scheduledEndDay: r.scheduled_end_day,
    actualEndDay: r.actual_end_day,
    endReason: r.end_reason,
    renewsTenancyId: r.renews_tenancy_id,
    status: r.status,
  }));
}

export interface AdminTenancyCandidate {
  personId: string;
  name: string;
  /** `contact` when they already hold the requested contact, else `name`. */
  matchedBy: 'contact' | 'name';
}

export interface AdminTenancyRequestRow {
  id: string;
  kind: 'new' | 'renewal';
  lotId: string;
  address: string;
  requesterName: string;
  /** A renewal names the renewed Tenancy's tenant. */
  tenantName: string;
  channel: 'email' | 'sms' | null;
  /** Unmasked: the board approves the contact. Null on a renewal. */
  contact: string | null;
  scheduledEndDay: string;
  renewsTenancyId: string | null;
  createdAt: number;
  /** The basis Ownership has ended or been voided, or its Lot retired, so
   * approval would fail and the panel offers only Refuse. */
  basisEnded: boolean;
  candidates: AdminTenancyCandidate[];
}

/**
 * The open-request queue of the board's Tenants panel, oldest first.
 *
 * For a `new` request it offers every unconsolidated Person whose normalized
 * name matches, or who already holds the requested contact: a contact two
 * identities share is not uniquely attributable, so the board sees both and
 * decides. Nothing matches automatically (Duplicate Owner Consolidation).
 *
 * Board-only, reachable only from the `requireBoard`-gated route.
 */
export async function fetchAdminTenancyRequests(
  env: Env,
  associationDay: string,
): Promise<AdminTenancyRequestRow[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT r.id, r.kind, r.lot_id, l.address, r.requested_by_person_id,
            rp.full_name AS requester_name, r.tenant_name, r.channel,
            r.contact_value, r.contact_normalized, r.scheduled_end_day,
            r.renews_tenancy_id, r.created_at,
            rt.tenant_person_id AS renewed_person_id,
            tp.full_name AS renewed_name,
            NOT ${basisCurrentSql('r.basis_ownership_id', 'r.lot_id', '?1')}
              AS basis_ended
     FROM tenancy_requests r
     JOIN lots l ON l.id = r.lot_id
     JOIN people rp ON rp.party_id = r.requested_by_person_id
     LEFT JOIN tenancies rt ON rt.id = r.renews_tenancy_id
     LEFT JOIN people tp ON tp.party_id = rt.tenant_person_id
     WHERE r.status = 'open'
     ORDER BY r.created_at, r.id`,
  )
    .bind(associationDay)
    .all<{
      id: string;
      kind: 'new' | 'renewal';
      lot_id: string;
      address: string;
      requested_by_person_id: string;
      requester_name: string | null;
      tenant_name: string | null;
      channel: 'email' | 'sms' | null;
      contact_value: string | null;
      contact_normalized: string | null;
      scheduled_end_day: string;
      renews_tenancy_id: string | null;
      created_at: number;
      renewed_person_id: string | null;
      renewed_name: string | null;
      basis_ended: number;
    }>();

  const newRequests = results.filter((r) => r.kind === 'new');
  const candidateResults =
    newRequests.length === 0
      ? []
      : await env.DATABASE.batch(
          newRequests.map((r) =>
            env.DATABASE.prepare(
              `SELECT p.party_id, p.full_name,
                      EXISTS (
                        SELECT 1 FROM contact_methods c
                        WHERE c.party_id = p.party_id AND c.channel = ?1
                          AND c.value_normalized = ?2
                          AND c.end_day IS NULL AND c.voided_at IS NULL
                      ) AS holds_contact
               FROM people p
               JOIN parties pa ON pa.id = p.party_id
               WHERE pa.consolidated_into_party_id IS NULL
                 AND (p.name_normalized = ?3 OR EXISTS (
                   SELECT 1 FROM contact_methods c
                   WHERE c.party_id = p.party_id AND c.channel = ?1
                     AND c.value_normalized = ?2
                     AND c.end_day IS NULL AND c.voided_at IS NULL
                 ))
               ORDER BY holds_contact DESC, p.full_name, p.party_id`,
            ).bind(
              r.channel,
              r.contact_normalized,
              normalizeName(r.tenant_name),
            ),
          ),
        );
  const candidatesById = new Map<string, AdminTenancyCandidate[]>();
  newRequests.forEach((r, i) =>
    candidatesById.set(
      r.id,
      (
        candidateResults[i].results as {
          party_id: string;
          full_name: string | null;
          holds_contact: number;
        }[]
      ).map((c) => ({
        personId: c.party_id,
        name: personDisplayLabel(c.full_name, c.party_id),
        matchedBy: c.holds_contact === 1 ? 'contact' : 'name',
      })),
    ),
  );

  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    lotId: r.lot_id,
    address: r.address,
    requesterName: personDisplayLabel(
      r.requester_name,
      r.requested_by_person_id,
    ),
    tenantName:
      r.tenant_name ??
      personDisplayLabel(r.renewed_name, r.renewed_person_id ?? r.id),
    channel: r.channel,
    contact: r.contact_value,
    scheduledEndDay: r.scheduled_end_day,
    renewsTenancyId: r.renews_tenancy_id,
    createdAt: r.created_at,
    basisEnded: r.basis_ended === 1,
    candidates: candidatesById.get(r.id) ?? [],
  }));
}

/** How long a refusal stays on the owner's page (spec decision 3). */
const REFUSAL_SHOWN_MS = 90 * 86_400_000;

/**
 * The owner's `/tenants` view: for each Lot the caller holds today, its
 * current and upcoming Tenancies, its open requests, and its refusals of the
 * last 90 days with the board's reason.
 *
 * Authority-scoped: `lotIds` is the caller's derived Lot Authority, and every
 * statement filters on it. A request's contact is masked, so the page shows no
 * contact value beyond its last characters; a decided request holds none.
 */
export async function fetchMemberTenancies(
  env: Env,
  lotIds: string[],
  associationDay: string,
  nowMs: number = Date.now(),
): Promise<MemberTenancyLot[]> {
  if (lotIds.length === 0) return [];
  const lotSet = JSON.stringify(lotIds);
  const inLots = (column: string) =>
    `${column} IN (SELECT value FROM json_each(?1))`;
  const [lotRows, tenancyRows, openRows, refusedRows] =
    await env.DATABASE.batch<Record<string, unknown>>([
      env.DATABASE.prepare(
        `SELECT id, address FROM lots WHERE ${inLots('id')} ORDER BY address, id`,
      ).bind(lotSet),
      env.DATABASE.prepare(
        `SELECT t.id, t.lot_id, t.tenant_person_id, p.full_name, t.start_day,
              t.scheduled_end_day,
              CASE WHEN ${tenancyCurrentSql('t', '?2')} THEN 'current'
                   ELSE 'upcoming' END AS status,
              EXISTS (
                SELECT 1 FROM person_links pl
                WHERE pl.person_id = t.tenant_person_id AND pl.ended_at IS NULL
              ) AS claimed
       FROM tenancies t
       JOIN people p ON p.party_id = t.tenant_person_id
       WHERE ${inLots('t.lot_id')}
         AND (${tenancyCurrentSql('t', '?2')}
              OR (t.start_day > ?2 AND ${tenancyCurrentSql('t', 't.start_day')}))
       ORDER BY t.start_day DESC, t.id`,
      ).bind(lotSet, associationDay),
      env.DATABASE.prepare(
        `SELECT r.id, r.lot_id, r.kind, r.tenant_name, r.channel,
              r.contact_value, r.scheduled_end_day, r.renews_tenancy_id,
              r.created_at, rt.tenant_person_id AS renewed_person_id,
              rp.full_name AS renewed_name
       FROM tenancy_requests r
       LEFT JOIN tenancies rt ON rt.id = r.renews_tenancy_id
       LEFT JOIN people rp ON rp.party_id = rt.tenant_person_id
       WHERE ${inLots('r.lot_id')} AND r.status = 'open'
       ORDER BY r.created_at, r.id`,
      ).bind(lotSet),
      env.DATABASE.prepare(
        `SELECT id, lot_id, kind, scheduled_end_day, decided_at, refusal_reason
       FROM tenancy_requests
       WHERE ${inLots('lot_id')} AND status = 'refused' AND decided_at >= ?2
       ORDER BY decided_at DESC, id`,
      ).bind(lotSet, nowMs - REFUSAL_SHOWN_MS),
    ]);

  const byLot = new Map<string, MemberTenancyLot>();
  for (const row of lotRows.results as { id: string; address: string }[])
    byLot.set(row.id, {
      lotId: row.id,
      address: row.address,
      tenancies: [],
      openRequests: [],
      refusedRequests: [],
    });

  for (const r of tenancyRows.results as {
    id: string;
    lot_id: string;
    tenant_person_id: string;
    full_name: string | null;
    start_day: string;
    scheduled_end_day: string;
    status: 'current' | 'upcoming';
    claimed: number;
  }[])
    byLot.get(r.lot_id)?.tenancies.push({
      id: r.id,
      tenantName: personDisplayLabel(r.full_name, r.tenant_person_id),
      startDay: r.start_day,
      scheduledEndDay: r.scheduled_end_day,
      status: r.status,
      claimed: r.claimed === 1,
    });

  for (const r of openRows.results as {
    id: string;
    lot_id: string;
    kind: 'new' | 'renewal';
    tenant_name: string | null;
    channel: 'email' | 'sms' | null;
    contact_value: string | null;
    scheduled_end_day: string;
    renews_tenancy_id: string | null;
    created_at: number;
    renewed_person_id: string | null;
    renewed_name: string | null;
  }[])
    byLot.get(r.lot_id)?.openRequests.push({
      id: r.id,
      kind: r.kind,
      tenantName:
        r.tenant_name ??
        personDisplayLabel(r.renewed_name, r.renewed_person_id ?? r.id),
      channel: r.channel,
      contact:
        r.contact_value === null || r.channel === null
          ? null
          : maskContact(r.channel, r.contact_value),
      scheduledEndDay: r.scheduled_end_day,
      renewsTenancyId: r.renews_tenancy_id,
      createdAt: r.created_at,
    });

  for (const r of refusedRows.results as {
    id: string;
    lot_id: string;
    kind: 'new' | 'renewal';
    scheduled_end_day: string;
    decided_at: number;
    refusal_reason: string;
  }[])
    byLot.get(r.lot_id)?.refusedRequests.push({
      id: r.id,
      kind: r.kind,
      scheduledEndDay: r.scheduled_end_day,
      decidedAt: r.decided_at,
      refusalReason: r.refusal_reason,
    });

  return [...byLot.values()];
}

// ---------------------------------------------------------------------------
// Board service
// ---------------------------------------------------------------------------

export interface BoardServiceTermRow {
  id: string;
  personId: string;
  personName: string;
  qualifyingLotId: string | null;
  qualifyingLotAddress: string | null;
  electionId: string | null;
  startDay: string;
  scheduledEndDay: string;
  actualEndDay: string | null;
  cancelledDay: string | null;
  voided: boolean;
  current: boolean;
}

export interface BoardOfficeRow {
  id: string;
  boardTermId: string;
  personId: string;
  personName: string;
  office: Office;
  startDay: string;
  endDay: string | null;
  voided: boolean;
  current: boolean;
}

/** Live-derived composition and office warnings (#203). Advisory only — none
 * of these blocks a write, and none is ever a Review Flag. */
export interface BoardServiceAdvisories {
  currentMemberCount: number;
  belowMinimum: boolean;
  aboveMaximum: boolean;
  vacantOffices: Office[];
  /** Current terms whose scheduled end falls within thirty days. */
  expiringTermIds: string[];
  /** Terms that lapsed at their scheduled end with no successor recorded. */
  lapsedTermIds: string[];
}

export interface BoardServiceDetail {
  terms: BoardServiceTermRow[];
  offices: BoardOfficeRow[];
  advisories: BoardServiceAdvisories;
}

const addDays = (day: string, days: number): string => {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
};

export async function fetchBoardService(
  env: Env,
  associationDay: string,
): Promise<BoardServiceDetail> {
  const db = getDb(env);
  const [termRows, officeRows, personRows, lotRows] = await Promise.all([
    db.select().from(boardTerms).orderBy(asc(boardTerms.startDay)),
    db
      .select()
      .from(boardOfficeAssignments)
      .orderBy(asc(boardOfficeAssignments.startDay)),
    db.select().from(people),
    db.select({ id: lotsTable.id, address: lotsTable.address }).from(lotsTable),
  ]);

  const names = new Map(
    personRows.map((p) => [
      p.partyId,
      personDisplayLabel(p.fullName, p.partyId),
    ]),
  );
  const addresses = new Map(lotRows.map((l) => [l.id, l.address]));

  const termCurrent = (t: (typeof termRows)[number]): boolean =>
    !t.voidedAt &&
    !t.cancelledAt &&
    t.startDay <= associationDay &&
    associationDay < (t.actualEndDay ?? t.scheduledEndDay);

  const terms: BoardServiceTermRow[] = termRows.map((t) => ({
    id: t.id,
    personId: t.personId,
    personName: names.get(t.personId) ?? personDisplayLabel(null, t.personId),
    qualifyingLotId: t.qualifyingLotId,
    qualifyingLotAddress: t.qualifyingLotId
      ? (addresses.get(t.qualifyingLotId) ?? null)
      : null,
    electionId: t.electionId,
    startDay: t.startDay,
    scheduledEndDay: t.scheduledEndDay,
    actualEndDay: t.actualEndDay,
    cancelledDay: t.cancelledDay,
    voided: t.voidedAt !== null,
    current: termCurrent(t),
  }));

  const offices: BoardOfficeRow[] = officeRows.map((o) => ({
    id: o.id,
    boardTermId: o.boardTermId,
    personId: o.personId,
    personName: names.get(o.personId) ?? personDisplayLabel(null, o.personId),
    office: o.office,
    startDay: o.startDay,
    endDay: o.endDay,
    voided: o.voidedAt !== null,
    current:
      !o.voidedAt &&
      o.startDay <= associationDay &&
      (o.endDay === null || associationDay < o.endDay),
  }));

  const current = terms.filter((t) => t.current);
  const expiryThreshold = addDays(associationDay, 30);
  const heldOffices = new Set(
    offices.filter((o) => o.current).map((o) => o.office),
  );
  // Lapsed: concluded by schedule alone, with no successor term recorded for
  // that person — the loud version of "the bylaws contain no holdover clause".
  const lapsedTermIds = termRows
    .filter(
      (t) =>
        !t.voidedAt &&
        !t.cancelledAt &&
        !t.actualEndDay &&
        t.scheduledEndDay <= associationDay &&
        !termRows.some(
          (s) =>
            s.personId === t.personId &&
            !s.voidedAt &&
            !s.cancelledAt &&
            s.startDay >= t.scheduledEndDay,
        ),
    )
    .map((t) => t.id);

  return {
    terms,
    offices,
    advisories: {
      currentMemberCount: current.length,
      belowMinimum: current.length < 3,
      aboveMaximum: current.length > 5,
      vacantOffices: OFFICES.filter((o) => !heldOffices.has(o)),
      expiringTermIds: current
        .filter((t) => t.scheduledEndDay <= expiryThreshold)
        .map((t) => t.id),
      lapsedTermIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Access grants
// ---------------------------------------------------------------------------

export interface AccessGrantRow {
  id: string;
  accountId: string;
  accountEmail: string | null;
  grantType: 'board' | 'system_admin';
  qualifyingBoardTermId: string | null;
  startedAt: number;
  endedAt: number | null;
  grantReason: string | null;
  endReason: string | null;
  live: boolean;
}

export async function fetchAccessGrantsDetail(
  env: Env,
): Promise<AccessGrantRow[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: accessGrants.id,
      accountId: accessGrants.accountId,
      accountEmail: users.email,
      grantType: accessGrants.grantType,
      qualifyingBoardTermId: accessGrants.qualifyingBoardTermId,
      startedAt: accessGrants.startedAt,
      endedAt: accessGrants.endedAt,
      grantReason: accessGrants.grantReason,
      endReason: accessGrants.endReason,
    })
    .from(accessGrants)
    .leftJoin(users, eq(users.id, accessGrants.accountId))
    .orderBy(asc(accessGrants.startedAt));
  return rows.map((g) => ({
    ...g,
    startedAt: g.startedAt.getTime(),
    endedAt: toMs(g.endedAt),
    live: g.endedAt === null,
  }));
}

// ---------------------------------------------------------------------------
// Member self-read
// ---------------------------------------------------------------------------

export interface MemberRosterSelf {
  person: { partyId: string; displayName: string; nameRedacted: boolean };
  contactMethods: {
    id: string;
    channel: 'email' | 'sms';
    value: string | null;
    redacted: boolean;
    isPreferred: boolean;
    current: boolean;
  }[];
  ownerships: {
    id: string;
    lotId: string;
    lotAddress: string | null;
    startDay: string | null;
    endDay: string | null;
    current: boolean;
  }[];
  representations: {
    id: string;
    organizationName: string;
    scopeKind: 'organization' | 'lots';
    startDay: string;
    endDay: string | null;
    current: boolean;
  }[];
  openRequests: {
    id: string;
    kind: 'name' | 'contact_method';
    contactMethodId: string | null;
    proposedValue: string;
    createdAt: number;
  }[];
}

/**
 * What a member sees about THEMSELVES (#205): their Person record, Contact
 * Methods, Ownerships, Representations, and open correction requests. Never
 * the audit ledger in any form, and never another party's data — everything
 * here is keyed on the caller's own linked Person.
 */
export async function fetchMemberRosterSelf(
  env: Env,
  personId: string,
  associationDay: string,
): Promise<MemberRosterSelf | null> {
  const db = getDb(env);
  const [person] = await db
    .select()
    .from(people)
    .where(eq(people.partyId, personId));
  if (!person) return null;

  const [contactRows, ownershipRows, repRows, orgRows, requestRows] =
    await Promise.all([
      db
        .select()
        .from(contactMethods)
        .where(eq(contactMethods.partyId, personId)),
      db.select().from(ownerships).where(eq(ownerships.ownerPartyId, personId)),
      db
        .select()
        .from(representations)
        .where(eq(representations.representativePersonId, personId)),
      db.select().from(organizations),
      db
        .select()
        .from(correctionRequests)
        .where(eq(correctionRequests.personId, personId)),
    ]);

  const lotRows = await db
    .select({ id: lotsTable.id, address: lotsTable.address })
    .from(lotsTable);
  const addresses = new Map(lotRows.map((l) => [l.id, l.address]));
  const orgNames = new Map(
    orgRows.map((o) => [o.partyId, o.displayName ?? o.legalName]),
  );

  return {
    person: {
      partyId: person.partyId,
      displayName: personDisplayLabel(person.fullName, person.partyId),
      nameRedacted: person.nameRedactedAt !== null,
    },
    contactMethods: contactRows
      .filter((c) => !c.voidedAt)
      .map((c) => ({
        id: c.id,
        channel: c.channel,
        value: c.value,
        redacted: c.redactedAt !== null,
        isPreferred: c.isPreferred,
        current: dayCurrent(c.startDay, c.endDay, associationDay),
      })),
    ownerships: ownershipRows
      .filter((o) => !o.voidedAt)
      .map((o) => ({
        id: o.id,
        lotId: o.lotId,
        lotAddress: addresses.get(o.lotId) ?? null,
        startDay: o.startDay,
        endDay: o.endDay,
        current: dayCurrent(o.startDay, o.endDay, associationDay),
      })),
    representations: repRows
      .filter((r) => !r.voidedAt)
      .map((r) => ({
        id: r.id,
        organizationName:
          orgNames.get(r.organizationPartyId) ?? r.organizationPartyId,
        scopeKind: r.scopeKind,
        startDay: r.startDay,
        endDay: r.endDay,
        current: dayCurrent(r.startDay, r.endDay, associationDay),
      })),
    openRequests: requestRows
      .filter((r) => r.status === 'open')
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        contactMethodId: r.contactMethodId,
        proposedValue: r.proposedValue,
        createdAt: r.createdAt.getTime(),
      })),
  };
}
