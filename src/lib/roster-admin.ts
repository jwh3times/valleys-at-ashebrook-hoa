// Client helpers for the ADR 0022 new-model admin surfaces (phase 3e, #221):
// the roster, board-service, access-grant, person-link, verification-request,
// correction-request, review-flag, redaction, and roster-export routes built
// by phases 3b/3c/3d.
//
// This module is the single seam between the new admin panels and those
// routes. `src/lib/admin.ts` stays legacy-only; the two never merge, because
// phase 4 (#212) deletes the legacy half and keeps this one.
//
// Every interface below MIRRORS a route's request or response contract — it
// is deliberately re-declared rather than imported, because `src/server/**`
// and `src/pages/**` are server-only and must never reach a client bundle.
// When a route contract changes, change the mirror here in the same commit.
//
// Two conventions worth knowing before editing:
//
//  - Timestamps from these routes are epoch MILLISECONDS (`number`), not the
//    ISO strings the legacy admin API returns. Day-valued fields stay
//    `YYYY-MM-DD` strings.
//  - Several routes decide what to write by KEY PRESENCE (`'electionId' in
//    body`) rather than by value, so that `null` can mean "clear this". The
//    helpers for those actions take a patch object and spread it: an omitted
//    key is dropped by `JSON.stringify`, so `undefined` reads as absent and
//    `null` reads as an explicit clear. Do not "helpfully" default those
//    fields.

/**
 * Every call goes through here, so a failure surfaces the server's own
 * plain-text message — these routes go to real trouble over them ("A current
 * board term names this lot as its qualifying lot — substitute or end the
 * term first"), and a panel that reported "Request failed: 409" would throw
 * away the only thing the board needed to read.
 *
 * `fallback` is used only when the response body is empty.
 */
async function rosterRequest<T = void>(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
  fallback = 'Request failed',
): Promise<T> {
  const res =
    method === 'GET'
      ? await fetch(url)
      : // Spelled as the literal rather than the narrowed `method`, so the
        // no-invalid-fetch-options lint can see this branch never sends a body
        // on a GET. Every write on these routes is an action-bus POST.
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
  if (!res.ok)
    throw new Error((await res.text()) || `${fallback}: ${res.status}`);
  // Actions answer 204; reads and creates carry a body.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
// Each route accepts its own subset of evidence kinds, because each writes a
// different ledger detail table and those tables carry different locator
// columns. The subsets are named rather than collapsed into one union so a
// panel cannot offer a kind its route will reject with a 400.

export interface EvidenceObservation {
  kind: 'operator_observation';
}
export interface EvidenceDocument {
  kind: 'document';
  documentId: string;
}
export interface EvidenceMeeting {
  kind: 'meeting';
  meetingId: string;
}
export interface EvidenceElection {
  kind: 'election';
  electionId: string;
}
export interface EvidenceRequest {
  kind: 'request';
  requestId: string;
}
export interface EvidenceExternal {
  kind: 'external';
  externalReference: string;
}

/** Lots and Parties: observation, document, or external reference only. */
export type BasicEvidence =
  EvidenceObservation | EvidenceDocument | EvidenceExternal;

/** Ownerships and Representations: the full locator set. */
export type RosterEvidence =
  BasicEvidence | EvidenceMeeting | EvidenceElection | EvidenceRequest;

/** Board service: no `request` locator — that column does not exist there. */
export type BoardServiceEvidence =
  BasicEvidence | EvidenceMeeting | EvidenceElection;

/** Person Links: no `election` locator — an election proves nothing about
 * who an account is (#219). */
export type IdentityEvidence =
  BasicEvidence | EvidenceMeeting | EvidenceRequest;

// ---------------------------------------------------------------------------
// Roster — GET /api/admin/roster
// ---------------------------------------------------------------------------

export interface RosterLotRow {
  id: string;
  address: string;
  unit: string | null;
  voteWeight: number;
  retiredDay: string | null;
  retiredAt: number | null;
  /** Live-derived advisory: unretired with no current Ownership. */
  ownerless: boolean;
}

export interface RosterPersonRow {
  partyId: string;
  /** Real name or the durable-ID redaction fallback — never null, and never
   * re-derived client-side. */
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

export type RepresentationScopeKind = 'organization' | 'lots';

export interface RosterRepresentationRow {
  id: string;
  representativePersonId: string;
  organizationPartyId: string;
  scopeKind: RepresentationScopeKind;
  scopeLotIds: string[];
  startDay: string;
  endDay: string | null;
  voided: boolean;
  current: boolean;
}

export type ContactChannel = 'email' | 'sms';

export interface RosterContactMethodRow {
  id: string;
  partyId: string;
  channel: ContactChannel;
  /** The value, or null when redacted. */
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

/** The whole Roster surface in one full-detail read. */
export async function fetchRoster(): Promise<AdminRoster> {
  return rosterRequest<AdminRoster>(
    '/api/admin/roster',
    'GET',
    undefined,
    'Load roster failed',
  );
}

// ---------------------------------------------------------------------------
// Roster — POST /api/admin/roster-lots
// ---------------------------------------------------------------------------

export interface RetireLotInput {
  lotId: string;
  /** Defaults to today; may be backdated, never future-dated. */
  effectiveDay?: string;
  evidence?: BasicEvidence;
}

export async function retireLot(input: RetireLotInput): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-lots',
    'POST',
    { action: 'retire', ...input },
    'Retire lot failed',
  );
}

/** Restores a Lot retired in error. Deliberately does NOT restore the
 * Ownerships that retirement ended — each is its own void-and-recreate. */
export async function correctLotRetirement(lotId: string): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-lots',
    'POST',
    { action: 'correctRetirement', lotId },
    'Correct retirement failed',
  );
}

// ---------------------------------------------------------------------------
// Roster — POST /api/admin/roster-parties
// ---------------------------------------------------------------------------

export interface CreatePersonInput {
  fullName: string;
  evidence?: BasicEvidence;
}

export async function createPerson(
  input: CreatePersonInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/roster-parties',
    'POST',
    { action: 'createPerson', ...input },
    'Create person failed',
  );
}

export interface CreateOrganizationInput {
  legalName: string;
  displayName?: string;
  evidence?: BasicEvidence;
}

/** Organization names are deliberately not unique: a normalized-name
 * collision comes back as `warning` on a successful create, for the panel to
 * surface, rather than as a refusal. */
export async function createOrganization(
  input: CreateOrganizationInput,
): Promise<{ id: string; warning?: string }> {
  return rosterRequest<{ id: string; warning?: string }>(
    '/api/admin/roster-parties',
    'POST',
    { action: 'createOrganization', ...input },
    'Create organization failed',
  );
}

export interface CorrectPersonNameInput {
  personId: string;
  fullName: string;
  evidence?: BasicEvidence;
}

export async function correctPersonName(
  input: CorrectPersonNameInput,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-parties',
    'POST',
    { action: 'correctPersonName', ...input },
    'Correct name failed',
  );
}

/** Key-presence patch: omit a field to leave it alone, pass `displayName:
 * null` to clear it. */
export interface CorrectOrganizationNamePatch {
  legalName?: string;
  displayName?: string | null;
}

export async function correctOrganizationName(
  organizationId: string,
  patch: CorrectOrganizationNamePatch,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-parties',
    'POST',
    { action: 'correctOrganizationName', organizationId, ...patch },
    'Correct name failed',
  );
}

export interface ConsolidatePartiesInput {
  duplicatePartyId: string;
  /** Named explicitly, never inferred — the one unsafe-to-guess decision. */
  survivorPartyId: string;
  evidence?: BasicEvidence;
}

export async function consolidateParties(
  input: ConsolidatePartiesInput,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-parties',
    'POST',
    { action: 'consolidate', ...input },
    'Consolidate failed',
  );
}

/** Clears the consolidation pointer. There is no `unconsolidate`: this is an
 * audited correction of a mistake, not an undo. */
export async function correctConsolidation(
  duplicatePartyId: string,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-parties',
    'POST',
    { action: 'correctConsolidation', duplicatePartyId },
    'Correct consolidation failed',
  );
}

// ---------------------------------------------------------------------------
// Roster — POST /api/admin/roster-ownerships
// ---------------------------------------------------------------------------

/** One per Board Term the ending would otherwise terminate: name a
 * replacement qualifying Lot instead. Omitted terms terminate by default. */
export interface TermSubstitution {
  termId: string;
  qualifyingLotId: string;
}

export interface CreateOwnershipInput {
  ownerPartyId: string;
  lotId: string;
  /** Required; never future-dated. Create accepts no end day. */
  startDay: string;
  evidence?: RosterEvidence;
}

export async function createOwnership(
  input: CreateOwnershipInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/roster-ownerships',
    'POST',
    { action: 'create', ...input },
    'Record ownership failed',
  );
}

export interface EndOwnershipInput {
  ownershipId: string;
  /** Required; may be backdated, never future-dated. */
  endDay: string;
  substitutions?: TermSubstitution[];
  evidence?: RosterEvidence;
}

/** The transfer path: resets the departing Lot's open member-motion votes and
 * opens Review Flags for anything else it disturbs. */
export async function endOwnership(input: EndOwnershipInput): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-ownerships',
    'POST',
    { action: 'end', ...input },
    'End ownership failed',
  );
}

/** A void is not a transfer: no vote is reset, and this Ownership's own open
 * flags are superseded rather than deleted. */
export async function voidOwnership(ownershipId: string): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-ownerships',
    'POST',
    { action: 'void', ownershipId },
    'Void ownership failed',
  );
}

// ---------------------------------------------------------------------------
// Roster — POST /api/admin/roster-representations
// ---------------------------------------------------------------------------

/** Scope is an XOR: `organization` covers every Lot the org currently owns
 * and takes no `lotIds`; `lots` requires a non-empty list, each currently
 * owned by that organization. */
export type RepresentationScopeInput =
  { scopeKind: 'organization' } | { scopeKind: 'lots'; lotIds: string[] };

export type CreateRepresentationInput = {
  representativePersonId: string;
  organizationPartyId: string;
  startDay: string;
  /** MAY be future-dated — a management agreement has a written term. */
  endDay?: string;
  evidence?: RosterEvidence;
} & RepresentationScopeInput;

export async function createRepresentation(
  input: CreateRepresentationInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/roster-representations',
    'POST',
    { action: 'create', ...input },
    'Record representation failed',
  );
}

export interface EndRepresentationInput {
  representationId: string;
  /** Defaults to today. A future end day removes no authority yet. */
  endDay?: string;
  substitutions?: TermSubstitution[];
  evidence?: RosterEvidence;
}

export async function endRepresentation(
  input: EndRepresentationInput,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-representations',
    'POST',
    { action: 'end', ...input },
    'End representation failed',
  );
}

export async function voidRepresentation(
  representationId: string,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-representations',
    'POST',
    { action: 'void', representationId },
    'Void representation failed',
  );
}

/** Scope rows are voided, never deleted; a concluded Representation refuses
 * the correction. */
export async function correctRepresentationScope(
  representationId: string,
  scope: RepresentationScopeInput,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-representations',
    'POST',
    { action: 'correctScope', representationId, ...scope },
    'Correct scope failed',
  );
}

// ---------------------------------------------------------------------------
// Roster — POST /api/admin/roster-contact-methods
// ---------------------------------------------------------------------------
// No evidence parameter anywhere on this surface: contact changes are always
// recorded as operator observation, and the ledger sees only the CATEGORY of
// what changed (email / phone), never the value.

export interface AddContactMethodInput {
  partyId: string;
  channel: ContactChannel;
  value: string;
  /** Defaults to open-ended; never future-dated. */
  startDay?: string;
  /** Clears the party's previous preferred method on that channel. */
  isPreferred?: boolean;
}

export async function addContactMethod(
  input: AddContactMethodInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/roster-contact-methods',
    'POST',
    { action: 'add', ...input },
    'Add contact method failed',
  );
}

export interface EndContactMethodInput {
  contactMethodId: string;
  /** Defaults to today. */
  endDay?: string;
}

export async function endContactMethod(
  input: EndContactMethodInput,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-contact-methods',
    'POST',
    { action: 'end', ...input },
    'End contact method failed',
  );
}

export async function voidContactMethod(
  contactMethodId: string,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-contact-methods',
    'POST',
    { action: 'void', contactMethodId },
    'Void contact method failed',
  );
}

/** Idempotent: setting an already-preferred method succeeds and writes
 * nothing. */
export async function setPreferredContactMethod(
  contactMethodId: string,
): Promise<void> {
  await rosterRequest(
    '/api/admin/roster-contact-methods',
    'POST',
    { action: 'setPreferred', contactMethodId },
    'Set preferred failed',
  );
}

// ---------------------------------------------------------------------------
// Roster — POST /api/admin/roster-export
// ---------------------------------------------------------------------------

export interface RosterExport {
  generatedAt: number;
  roster: AdminRoster;
}

/**
 * The one read that is also a recorded act: the Access Event is written and
 * committed BEFORE any roster row is assembled, and the export is withheld
 * entirely if that write fails. Nothing is persisted server-side.
 *
 * A panel must confirm before calling this.
 */
export async function exportRoster(): Promise<RosterExport> {
  return rosterRequest<RosterExport>(
    '/api/admin/roster-export',
    'POST',
    {},
    'Export failed',
  );
}

// ---------------------------------------------------------------------------
// Board service — GET + POST /api/admin/board-service
// ---------------------------------------------------------------------------

export const OFFICES = [
  'president',
  'vice_president',
  'secretary_treasurer',
] as const;
export type Office = (typeof OFFICES)[number];

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

/** Live-derived advisories. None of these blocks a write, and none is ever a
 * Review Flag. */
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

export async function fetchBoardService(): Promise<BoardServiceDetail> {
  return rosterRequest<BoardServiceDetail>(
    '/api/admin/board-service',
    'GET',
    undefined,
    'Load board service failed',
  );
}

// The three ending kinds are disjoint and separately named on purpose — end
// (it ran and stopped), cancel (it never started), void (it was never a
// fact). Each takes its own reason set; never collapse them into one control.
export type BoardTermCreateReason = 'elected' | 'vacancy_appointment';
export type BoardTermEndReason =
  'term_expired' | 'resigned' | 'removed' | 'declared_vacant_absences';
export type BoardTermCancelReason =
  'resigned' | 'removed' | 'recorded_in_error';

export interface CreateBoardTermInput {
  personId: string;
  qualifyingLotId: string;
  reasonCode: BoardTermCreateReason;
  startDay: string;
  scheduledEndDay: string;
  /** Provenance only; a term may exist without an election. */
  electionId?: string;
  evidence?: BoardServiceEvidence;
}

export async function createBoardTerm(
  input: CreateBoardTermInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/board-service',
    'POST',
    { action: 'createTerm', ...input },
    'Create term failed',
  );
}

export interface EndBoardTermInput {
  termId: string;
  reasonCode: BoardTermEndReason;
  /** Required; after the term's start, never future-dated. */
  endDay: string;
  evidence?: BoardServiceEvidence;
}

/** Ends a term that ran: its current offices end, and its Board grants end at
 * recorded-at (never on a backdated service day). */
export async function endBoardTerm(input: EndBoardTermInput): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'endTerm', ...input },
    'End term failed',
  );
}

/** Cancels a term that has not started yet; an already-started term must be
 * ended instead. */
export async function cancelBoardTerm(input: {
  termId: string;
  reasonCode: BoardTermCancelReason;
}): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'cancelTerm', ...input },
    'Cancel term failed',
  );
}

/** Voids a term recorded in error, clearing any end or cancellation on it. */
export async function voidBoardTerm(termId: string): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'voidTerm', termId },
    'Void term failed',
  );
}

export interface SubstituteQualifyingLotInput {
  termId: string;
  qualifyingLotId: string;
  evidence?: BoardServiceEvidence;
}

/** In-place substitution of the Lot that qualifies a live term — the escape
 * from terminating board service when an Ownership ends. */
export async function substituteQualifyingLot(
  input: SubstituteQualifyingLotInput,
): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'substituteQualifyingLot', ...input },
    'Substitute lot failed',
  );
}

/** Key-presence patch over the only two correctable fields: pass
 * `electionId: null` to clear the provenance link. Person, endpoints, and
 * endings are void-and-recreate, not edits. */
export interface CorrectBoardTermPatch {
  qualifyingLotId?: string;
  electionId?: string | null;
}

export async function correctBoardTerm(
  termId: string,
  patch: CorrectBoardTermPatch,
): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'correctTerm', termId, ...patch },
    'Correct term failed',
  );
}

export interface AssignOfficeInput {
  termId: string;
  office: Office;
  /** Defaults to today; must fall inside the term. */
  startDay?: string;
}

export async function assignOffice(
  input: AssignOfficeInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/board-service',
    'POST',
    { action: 'assignOffice', ...input },
    'Assign office failed',
  );
}

export interface EndOfficeInput {
  assignmentId: string;
  /** Defaults to today; must be after the assignment's start. */
  endDay?: string;
}

export async function endOffice(input: EndOfficeInput): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'endOffice', ...input },
    'End office failed',
  );
}

export async function voidOffice(assignmentId: string): Promise<void> {
  await rosterRequest(
    '/api/admin/board-service',
    'POST',
    { action: 'voidOffice', assignmentId },
    'Void office failed',
  );
}

// ---------------------------------------------------------------------------
// Access grants — GET + POST /api/admin/access-grants
// ---------------------------------------------------------------------------

export type GrantType = 'board' | 'system_admin';

export interface AccessGrantRow {
  id: string;
  accountId: string;
  accountEmail: string | null;
  grantType: GrantType;
  qualifyingBoardTermId: string | null;
  startedAt: number;
  endedAt: number | null;
  grantReason: string | null;
  endReason: string | null;
  live: boolean;
}

export async function fetchAccessGrants(): Promise<AccessGrantRow[]> {
  return rosterRequest<AccessGrantRow[]>(
    '/api/admin/access-grants',
    'GET',
    undefined,
    'Load access grants failed',
  );
}

export interface GrantAccessInput {
  accountId: string;
  grantType: GrantType;
  /** Required for a `board` grant, refused for a `system_admin` one. */
  qualifyingBoardTermId?: string;
}

/**
 * Board Access is never implicit: this route is the only writer. A grant
 * validates the account → Person Link → qualifying Term chain, and a
 * `system_admin` grant takes a System Administrator.
 */
export async function grantAccess(
  input: GrantAccessInput,
): Promise<{ id: string }> {
  return rosterRequest<{ id: string }>(
    '/api/admin/access-grants',
    'POST',
    { action: 'grant', ...input },
    'Grant failed',
  );
}

/** Revoking the last System Administrator is refused (409) and the refusal is
 * itself permanently recorded — surface the server's message verbatim. */
export async function revokeAccess(grantId: string): Promise<void> {
  await rosterRequest(
    '/api/admin/access-grants',
    'POST',
    { action: 'revoke', grantId },
    'Revoke failed',
  );
}

// ---------------------------------------------------------------------------
// Person links — GET + POST /api/admin/person-links
// ---------------------------------------------------------------------------

export interface PersonLinkRow {
  id: string;
  accountId: string;
  accountEmail: string | null;
  accountName: string | null;
  personId: string;
  personDisplayName: string;
  startedAt: number;
  endedAt: number | null;
  endedByAccountId: string | null;
  endReason: string | null;
  current: boolean;
  verification: {
    id: string;
    method: string;
    reason: string | null;
    verifiedAt: number;
    approverAccountId: string | null;
  };
}

export async function fetchPersonLinks(): Promise<PersonLinkRow[]> {
  return rosterRequest<PersonLinkRow[]>(
    '/api/admin/person-links',
    'GET',
    undefined,
    'Load person links failed',
  );
}

export type ManualVerifyReason =
  'manual_board_decision' | 'migration_reverification';

/** `self_unlink` is deliberately absent: it belongs to the applicant's own
 * unlink route, not to an administrator ending someone else's link. */
export type PersonLinkEndReason =
  | 'account_replaced'
  | 'no_longer_qualifies'
  | 'suspected_compromise'
  | 'recorded_in_error'
  | 'resident_request';

export interface ManualVerifyInput {
  accountId: string;
  /** An EXISTING Person — manual verification never creates one. */
  personId: string;
  reason: ManualVerifyReason;
  /** Required on this route, unlike the roster surfaces. */
  evidence: IdentityEvidence;
}

export async function manualVerifyPersonLink(
  input: ManualVerifyInput,
): Promise<{ id: string; verificationId: string }> {
  return rosterRequest<{ id: string; verificationId: string }>(
    '/api/admin/person-links',
    'POST',
    { action: 'manualVerify', ...input },
    'Manual verification failed',
  );
}

/** Ends the link and every Access Grant it currently supports, in one batch.
 * Refused for the last System Administrator. */
export async function unlinkPersonLink(input: {
  linkId: string;
  endReason: PersonLinkEndReason;
}): Promise<void> {
  await rosterRequest(
    '/api/admin/person-links',
    'POST',
    { action: 'unlink', ...input },
    'Unlink failed',
  );
}

// ---------------------------------------------------------------------------
// Verification requests — GET + POST /api/admin/verification-requests
// ---------------------------------------------------------------------------

/** `claimedAddress` and `claimedName` are applicant free text — display them,
 * never treat them as roster facts. GET returns OPEN requests only. */
export interface VerificationReviewRequestRow {
  id: string;
  accountId: string;
  accountEmail: string | null;
  claimedAddress: string;
  claimedName: string;
  channel: ContactChannel | null;
  internalReason: string;
  createdAt: number;
}

export async function fetchVerificationRequests(): Promise<
  VerificationReviewRequestRow[]
> {
  return rosterRequest<VerificationReviewRequestRow[]>(
    '/api/admin/verification-requests',
    'GET',
    undefined,
    'Load verification requests failed',
  );
}

export interface AcceptVerificationRequestInput {
  id: string;
  /** The Person the board decides the applicant is. */
  personId: string;
  /** Defaults server-side to `manual_board_decision`. */
  reason?: ManualVerifyReason;
}

/** Acceptance is a manual verification whose evidence cites this request. */
export async function acceptVerificationRequest(
  input: AcceptVerificationRequestInput,
): Promise<{ linkId: string; verificationId: string }> {
  return rosterRequest<{ linkId: string; verificationId: string }>(
    '/api/admin/verification-requests',
    'POST',
    { action: 'accept', ...input },
    'Accept failed',
  );
}

/** A decline writes no link and no verification — only a durable Identity
 * Event recording the refusal. */
export async function declineVerificationRequest(id: string): Promise<void> {
  await rosterRequest(
    '/api/admin/verification-requests',
    'POST',
    { action: 'decline', id },
    'Decline failed',
  );
}

// ---------------------------------------------------------------------------
// Correction requests — GET + POST /api/admin/correction-requests
// ---------------------------------------------------------------------------

export type CorrectionRequestKind = 'name' | 'contact_method';
export type CorrectionRequestStatus =
  'open' | 'accepted' | 'declined' | 'withdrawn';

/** `proposedValue` and `note` are member free text; they never enter the
 * ledger, and accepting one lands only the value itself as the new fact. GET
 * returns every request, newest first. */
export interface CorrectionRequestRow {
  id: string;
  accountId: string;
  personId: string;
  personDisplayName: string;
  kind: CorrectionRequestKind;
  contactMethodId: string | null;
  targetChannel: ContactChannel | null;
  targetCurrentValue: string | null;
  channel: ContactChannel | null;
  proposedValue: string;
  note: string | null;
  status: CorrectionRequestStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedByAccountId: string | null;
}

export async function fetchCorrectionRequests(): Promise<
  CorrectionRequestRow[]
> {
  return rosterRequest<CorrectionRequestRow[]>(
    '/api/admin/correction-requests',
    'GET',
    undefined,
    'Load correction requests failed',
  );
}

export async function acceptCorrectionRequest(
  requestId: string,
): Promise<void> {
  await rosterRequest(
    '/api/admin/correction-requests',
    'POST',
    { action: 'accept', requestId },
    'Accept failed',
  );
}

export async function declineCorrectionRequest(
  requestId: string,
): Promise<void> {
  await rosterRequest(
    '/api/admin/correction-requests',
    'POST',
    { action: 'decline', requestId },
    'Decline failed',
  );
}

// ---------------------------------------------------------------------------
// Review flags — GET + POST /api/admin/review-flags
// ---------------------------------------------------------------------------

/** The typed impacted reference. `impacted` is null when the referenced
 * record has since been deleted or replaced (the flag's FKs are SET NULL) —
 * render that as exactly that, never as an error. */
export type ImpactedKind =
  | 'proxy'
  | 'member_attendance'
  | 'member_vote'
  | 'motion'
  | 'ballot'
  | 'board_term'
  | 'access_grant'
  | 'audit_event';

export type ReviewFlagCategory =
  | 'intervening_action_backdated'
  | 'authority_lost_pending_occasion'
  | 'vote_reset_on_transfer'
  | 'ballot_final_after_transfer';

/** The codes a HUMAN may choose. `superseded` is reserved for the automatic
 * void/correction path and is refused (400) by the route — never offer it. */
export const REVIEW_RESOLUTION_CODES = [
  'remediated',
  'confirmed_valid',
  'no_effect',
] as const;
export type ReviewResolutionCode = (typeof REVIEW_RESOLUTION_CODES)[number];

export interface ReviewFlagRow {
  id: string;
  category: ReviewFlagCategory;
  status: 'open' | 'resolved';
  openedAt: number;
  resolvedAt: number | null;
  /** Includes `superseded` on rows the automatic path resolved. */
  resolutionCode: ReviewResolutionCode | 'superseded' | null;
  sourceEventId: string;
  sourceEvent: {
    eventKind: string;
    family: string;
    recordedAt: number;
    actorKind: string;
    actorAccountId: string | null;
    automaticCause: string | null;
  };
  impacted: { kind: ImpactedKind; id: string } | null;
}

/** Every flag, open first then most recently opened — a resolved flag stays
 * visible as history. */
export async function fetchReviewFlags(): Promise<ReviewFlagRow[]> {
  return rosterRequest<ReviewFlagRow[]>(
    '/api/admin/review-flags',
    'GET',
    undefined,
    'Load review flags failed',
  );
}

/** Resolving records that a human looked; it never rewrites, invalidates, or
 * hides the action the flag references. */
export async function resolveReviewFlag(
  id: string,
  resolutionCode: ReviewResolutionCode,
): Promise<void> {
  await rosterRequest(
    '/api/admin/review-flags',
    'POST',
    { action: 'resolve', id, resolutionCode },
    'Resolve failed',
  );
}

// ---------------------------------------------------------------------------
// Redactions — GET + POST /api/admin/redactions
// ---------------------------------------------------------------------------
// System-Administrator-only, on two distinct technical capabilities:
// `redactionAuthorize` for the read and the two redactions, the narrower
// `redactionCleanup` for recording a cleanup outcome. Under `cutover_mode =
// legacy` nobody holds either, so every caller gets a 403 until the flip —
// the Compliance panel renders that as a capability-required card, not an
// error.

export type RedactionFieldCategory = 'person_name' | 'email' | 'phone';
export type RedactionAuthorityKind = 'legal_requirement' | 'binding_policy';
export type RedactionTaskStatus = 'pending' | 'succeeded' | 'failed';
export type RedactionTaskTargetKind =
  'rag_corpus' | 'ai_search_index' | 'pseudonymizer_catalog' | 'export_cache';

/** Straight from the compliance view, so the columns are snake_case and the
 * timestamp is epoch milliseconds. */
export interface RedactionComplianceRow {
  event_id: string;
  recorded_at: number;
  performed_by_account_id: string | null;
  target_person_id: string | null;
  target_contact_method_id: string | null;
  field_category: RedactionFieldCategory;
  authorized_by_account_id: string;
  authority_kind: RedactionAuthorityKind;
  authority_reference: string;
  reason_code: string;
  task_count: number;
  tasks_pending: number;
  tasks_failed: number;
}

/** Raw task rows, likewise snake_case. */
export interface RedactionTaskRow {
  id: string;
  redaction_event_id: string;
  target_kind: RedactionTaskTargetKind;
  target_identifier: string;
  status: RedactionTaskStatus;
  attempts: number;
  last_error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface RedactionsView {
  compliance: RedactionComplianceRow[];
  tasks: RedactionTaskRow[];
}

export async function fetchRedactions(): Promise<RedactionsView> {
  return rosterRequest<RedactionsView>(
    '/api/admin/redactions',
    'GET',
    undefined,
    'Load redactions failed',
  );
}

/** Redaction is irreversible; a panel must confirm before calling either
 * redact helper. */
export interface RedactionAuthority {
  authorityKind: RedactionAuthorityKind;
  /** The statute, policy, or order relied on (300 characters or fewer). */
  authorityReference: string;
  /** A reason CODE, not free text (120 characters or fewer). */
  reason: string;
}

export async function redactPersonName(
  input: { personId: string } & RedactionAuthority,
): Promise<void> {
  await rosterRequest(
    '/api/admin/redactions',
    'POST',
    { action: 'redactPersonName', ...input },
    'Redact failed',
  );
}

export async function redactContactMethod(
  input: { contactMethodId: string } & RedactionAuthority,
): Promise<void> {
  await rosterRequest(
    '/api/admin/redactions',
    'POST',
    { action: 'redactContactMethod', ...input },
    'Redact failed',
  );
}

/** Operational state only — no ledger row. Records whether a downstream purge
 * succeeded, so the compliance view converges. */
export async function recordRedactionCleanup(input: {
  taskId: string;
  status: 'succeeded' | 'failed';
  errorCode?: string;
}): Promise<void> {
  await rosterRequest(
    '/api/admin/redactions',
    'POST',
    { action: 'recordCleanup', ...input },
    'Record cleanup failed',
  );
}

// ---------------------------------------------------------------------------
// Access denials — GET /api/admin/access-denials
// ---------------------------------------------------------------------------
// System-Administrator-only on the `accessDenialDetail` capability, and — like
// the redaction surface above — a 403 for every caller under `cutover_mode =
// legacy`. Rows come straight from the join over `access_events`, so the
// columns are snake_case and the timestamp is epoch milliseconds.
//
// This is the record of DENIED privileged acts only: grants, revocations,
// bootstrap, roster export, and the write path's own grant re-validation
// refusals. Ordinary 401/403 traffic never lands here, so an empty list does
// not mean nobody was ever refused anything.

export type AccessGrantAction =
  | 'grant'
  | 'revoke'
  | 'bootstrap'
  | 'roster_export'
  | 'last_administrator_change'
  | 'grant_precondition_revalidation';

export interface AccessDenialRow {
  /** The audit event's id, not the access-event detail row's. */
  id: string;
  recorded_at: number;
  actor_account_id: string | null;
  event_kind: string;
  access_grant_id: string | null;
  target_account_id: string | null;
  grant_type: GrantType | null;
  requested_action: AccessGrantAction;
  reason_code: string | null;
}

/** Newest first. */
export async function fetchAccessDenials(): Promise<AccessDenialRow[]> {
  return rosterRequest<AccessDenialRow[]>(
    '/api/admin/access-denials',
    'GET',
    undefined,
    'Load access denials failed',
  );
}

// ---------------------------------------------------------------------------
// Audit integrity — GET /api/admin/audit-integrity
// ---------------------------------------------------------------------------
// System-Administrator-only on the `auditIntegrityViews` capability. Both
// results are query shapes over the operator-run integrity views, never
// authorization boundaries: a non-empty list is an anomaly to investigate, and
// an EMPTY one is the expected, healthy state — a panel should say so rather
// than render a bare blank.

export type AuditIntegrityViolation =
  | 'detail_cardinality'
  | 'causal_order'
  | 'orphan_correction'
  | 'redaction_incomplete'
  | 'flag_without_opening_event';

export interface AuditIntegrityViolationRow {
  /** The offending audit event — or, for `flag_without_opening_event`, the
   * Review Flag that no Review Event ever opened. */
  event_id: string;
  violation: AuditIntegrityViolation;
}

export type BoardEligibilityViolation =
  'current_term_without_qualifying_lot' | 'qualifying_basis_missing';

export interface BoardEligibilityViolationRow {
  board_term_id: string;
  person_id: string;
  qualifying_lot_id: string | null;
  violation: BoardEligibilityViolation;
}

export interface AuditIntegrityView {
  auditViolations: AuditIntegrityViolationRow[];
  boardEligibilityViolations: BoardEligibilityViolationRow[];
}

export async function fetchAuditIntegrity(): Promise<AuditIntegrityView> {
  return rosterRequest<AuditIntegrityView>(
    '/api/admin/audit-integrity',
    'GET',
    undefined,
    'Load audit integrity failed',
  );
}

// ---------------------------------------------------------------------------
// Capability refusals
// ---------------------------------------------------------------------------

/**
 * True when a failure was the shared capability gate refusing the caller
 * (`requireApiCapability` answers a bare `403 Forbidden`, whose body
 * `rosterRequest` re-throws as the Error's whole message).
 *
 * It lives here, beside the request helper that produces the message, so a
 * panel never has to guess at server wording. The Compliance panel is the one
 * caller: every read it makes is System-Administrator-only, and under
 * `cutover_mode = legacy` nobody holds those capabilities, so this refusal is
 * the NORMAL pre-flip answer and has to render as an explanation rather than
 * as an error.
 *
 * Accepts either the thrown error or a message already extracted from one.
 */
export function isCapabilityRefusal(err: unknown): boolean {
  const message =
    typeof err === 'string'
      ? err
      : ((err as { message?: string } | null)?.message ?? '');
  return message === 'Forbidden';
}
