// Read assembly for the ADR 0022 phase-3b roster surfaces (#218): the
// board-only Roster / Board / Access reads and the member self-read.
//
// Privacy boundaries live HERE, as properties of the reads themselves:
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
import { properties } from '../db/schema';
import { users } from '../db/auth-schema';
import {
  parties,
  people,
  organizations,
  contactMethods,
  ownerships,
  representations,
  representationLots,
  boardServiceTerms,
  boardOfficeAssignments,
  accessGrants,
  correctionRequests,
} from '../db/roster-schema';
import { personDisplayLabel } from '../../lib/format';

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
  const [lotRows, personRows, orgRows, ownershipRows, repRows, repLotRows, contactRows] =
    await Promise.all([
      db.select().from(properties).orderBy(asc(properties.address)),
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
      current:
        !o.voidedAt && dayCurrent(o.startDay, o.endDay, associationDay),
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
      current:
        !r.voidedAt && dayCurrent(r.startDay, r.endDay, associationDay),
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
    db
      .select()
      .from(boardServiceTerms)
      .orderBy(asc(boardServiceTerms.startDay)),
    db
      .select()
      .from(boardOfficeAssignments)
      .orderBy(asc(boardOfficeAssignments.startDay)),
    db.select().from(people),
    db.select({ id: properties.id, address: properties.address }).from(properties),
  ]);

  const names = new Map(
    personRows.map((p) => [p.partyId, personDisplayLabel(p.fullName, p.partyId)]),
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
      db.select().from(contactMethods).where(eq(contactMethods.partyId, personId)),
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
    .select({ id: properties.id, address: properties.address })
    .from(properties);
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
