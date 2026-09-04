# HTTP endpoints

Every API route under `src/pages/api/`, with the guard order, error codes, and mutation-boundary
re-checks each one owes. Read the entry for a route before changing it; the codes and the order
they fire in are contract, and several are pinned by tests.

Two rules govern this whole surface and are stated once here rather than repeated per route:

- **Two-layer gating.** `src/middleware.ts` rejects a namespace before the route runs, and every
  handler independently opens with its own guard. The per-route call is the enforced and tested
  layer; the middleware gate is the production backstop. See
  [ADR 0013](../adr/0013-admin-api-gated-in-middleware.md) and the Roles & access section of
  `AGENTS.md`.
- **Re-check at the mutation boundary.** A passed preflight grants nothing. Visibility, authority,
  frozen eligibility, open state, feature flags, and duplicate exclusion are all repeated inside
  the mutation SQL, so a race returns `409` rather than a partial write.

## Routes

API routes live under `src/pages/api/`:

- Public tier-filtered reads: `GET /api/content/{announcements,documents,dues,site}`.
- Gated document download from R2 with tier checks: `GET /api/files/[id]`.
- Default-off live homeowner voting: `POST /api/vote` accepts `castBallot` and `castMotionVote`
  only; there is no GET voting endpoint. Middleware is the namespace backstop and the handler calls
  `requireVotingApi` independently. Its fixed guard order is: literal-boolean `officialMode` plus
  `liveVotingEnabled` (`404`), the operator-only write freeze (`503`, see
  `src/server/authz/write-freeze.ts` below), exact equality of the required `Origin` header with
  `new URL(request.url).origin` (`403`), `application/json` media type (`415`), authenticated
  session (`401`), then `homeowner`-or-higher role (`403`). Only then are the action and resource
  resolved. Out-of-tier or unknown occasions are masked as `404`; own-lot or occasion-scoped
  held-proxy authority — a held-proxy cast also re-checks that the proxy's grantor still holds Lot
  Authority over the lot (the ADR 0022 phase 3d grantor re-validation, #220/#204, asked of the
  party roster since #248 part 2, and exact at-the-occasion semantics for a live cast) — frozen-snapshot eligibility and weight, open state, both
  feature flags, and
  one cast per lot are re-checked inside the mutation SQL. Election turnout and identity-unlinked
  retained choices are a single checked D1 batch, and a race with close, pause, authority change,
  or another cast returns `409` without a partial write. Conducted ballots are final: supported
  reads expose only `hasCast`, never choices for display or replacement. Turning either flag off
  pauses new opens and casts without deleting lifecycle state, snapshots, turnout, votes, or
  choices; an occasion still open resumes when both flags return true.
- Board-only writes: `/api/admin/{documents,announcements,dues,site}` and
  `/api/admin/{properties,owners,members}`. `/api/admin/board-people` and
  `/api/admin/board-terms` were **retired by phase 3b (#218), not ported**: the identity layer
  moved to the party roster and `board_service_terms` (see the ADR 0022 roster routes below), and
  porting the legacy routes would have kept two identity layers alive. The legacy `board_people`
  table itself survives — `board_terms.person_id` still references it — but #248 (part 1 of 2, an
  ADR 0022 phase 4 precondition) repointed the meeting and elections records off it onto the party
  roster (migration `0028`), so
  the record-keeping pickers (attendance, mover/second, roll call, the candidate link) now read a
  flat `{id, fullName}` list of `people` — excluding consolidated parties, names rendered through
  `personDisplayLabel` — from `GET /api/admin/meetings?roster=people` instead. The legacy "The
  Board" editor stayed retired; the writable board-service surface is now the phase-3e (#221)
  **Board** panel (`BoardServicePanel`), which writes `board_service_terms`/
  `board_office_assignments` through `/api/admin/board-service` (see the ADR 0022 roster routes
  below), not the legacy `board_people`/`board_terms` tables.
  `POST /api/admin/documents` hashes uploads, blocks exact duplicates, warns on near duplicates,
  and stores `content_hash` on success; a confirmed near-duplicate upload also clears
  `keep_verified_at`/`keep_verified_by` on the existing documents it near-matches, so that
  duplicate group resurfaces for review.
- Board-only meeting record (board and member meetings — proxies recorded by the board or granted
  online by a homeowner attach to member attendance/votes and election ballots):
  `/api/admin/meetings` supports `GET`/`POST`/`PATCH`/`DELETE`.
  `GET` lists every
  meeting including drafts, or returns one full meeting detail with `?id=`; `POST`
  creates a meeting, or with `{ action: 'setAttendance' }` fully replaces a board meeting's
  per-person attendance roll, or with `{ action: 'setMemberAttendance' }` fully replaces a member
  meeting's per-property attendance roll, or with `{ action: 'approve' }`/`{ action: 'unapprove' }`
  flips `status` (`approve` returns `400` if `approvedByMotionId` names no motion — a motion from a
  different, normally following meeting is valid — and `409` if already approved or if a child
  motion vote is open, with the open-vote check in the conditional status update so approval
  cannot win that race;
  `unapprove` clears `approved_at`/`approved_by`/`approved_by_motion_id`); `PATCH` updates a meeting's fields but
  cannot write `status`; `DELETE` returns `409` on an approved meeting (unapprove first), `409` if
  any motion belonging to it is cited as a resolution's adopting motion (see the resolutions
  bullet below), `409` if an election records it as where it was held (see the elections bullet
  below), `409` if an election ballot cites a proxy scoped to this meeting (closes a raw-D1-error
  path that opens once an election's `meetingId` is detached from a meeting after ballots were
  recorded against a meeting-scoped proxy — the meeting-still-linked check above can't catch that
  case), and `409` if any child motion has a live-voting state or eligibility snapshot, otherwise
  cascading its attendance, motions, votes, and proxies. `/api/admin/motions`
  supports `POST`/`PATCH`/`DELETE`. `POST` creates a motion with a server-assigned `sequence`
  (unique per meeting), or with `{ action: 'setVotes' }` fully replaces a board motion's roll-call
  vote set, or with `{ action: 'setMemberVotes' }` fully replaces a member motion's per-property
  vote set, or with `{ action: 'openVoting' }`/`{ action: 'closeVoting' }` moves a member motion's
  live-voting state. First open requires both official mode and the default-false live-voting flag
  to be literal JSON booleans `true`, a draft member meeting, no pre-entered member votes, and at
  least one active property; it
  atomically freezes every active property's weight in `motion_eligibility`. Close is reversible
  while the meeting stays draft, and reopen retains the original eligibility snapshot and any live
  votes. `setMemberVotes` returns `409` while open; after first open it stamps weights from the
  immutable snapshot and performs the full replacement as a state-plus-`voting_revision`
  compare-and-swap in one D1 batch, so a stale correction cannot overwrite an intervening session.
  `PATCH` cannot edit a motion while open or change its text after first open; `DELETE` returns `409`
  if the motion is cited as a resolution's adopting motion or has any live-voting history,
  otherwise cascading its votes. `setAttendance`/`setMemberAttendance` and board `setVotes` each
  replace their full child set in one `db.batch()`. All four attendance/vote actions return
  `409` if the target meeting's or motion's `body` doesn't match the action — board attendance/votes
  against a member meeting/motion, or vice versa, are refused; all four full-replacement actions
  also pre-check every entry's referenced id before writing, so an unknown one is a readable `400`
  rather than a raw D1 FOREIGN KEY error out of the batch (#234): `setAttendance` and `setVotes`
  return `400 "Unknown personId in entries"` for an unknown `personId` (`board_attendance.person_id`
  and `board_votes.person_id`, both NOT NULL FKs to `people(party_id)`, checked by the shared
  `personExistenceError` guard described under Server code below); `setMemberAttendance` returns
  `400 "Unknown lots in entries: <ids>"` naming every offending id (its own lot-existence check,
  since — unlike its siblings — it stamps no weight, so nothing else resolves the lot); and
  `setMemberVotes` also returns `400`
  for an unknown `propertyId`, since it stamps `memberVotes.weight` from `properties.vote_weight` at
  recording time and must resolve that weight to build a legal row. `setMemberAttendance`,
  `setMemberVotes`, and (on `/api/admin/elections`) `setBallots` each take a per-entry `proxyId`
  instead of the old `viaProxy` boolean; every referenced proxy is checked by the shared
  `proxyUseError` guard (`src/server/content/proxy-guards.ts`) — unknown `proxyId` is `400`, a proxy
  for a different lot or scoped to a different occasion is `409` (a meeting-scoped proxy also
  covers an election held at that meeting; a standalone election accepts only its own), a proxy
  whose grantor did not hold Lot Authority over the proxy's lot on the occasion day is `409` (the
  ADR 0022 phase 3d grantor re-validation, #220/#204, asked of the party roster since #248 part 2;
  meeting attendance and votes use `meetings.date`, while recorded-election ballots use
  `elections.election_date`, including a meeting-scoped proxy covering that election). The same
  proxy predicates are repeated inside each full-replacement batch, so a concurrent proxy or roster
  correction returns `409` without replacing any existing rows. An entry carrying both `proxyId` and
  `representedByPersonId`/`castByPersonId` is `400`, since who acted
  lives on the canonical proxy row, never beside it. All verbs on both routes are
  `requireBoard`-gated.
- Board-only resolutions book (standing rules the board adopts; a durable record — amending one
  creates a **new** resolution that supersedes the old, forming a walkable chain; see
  [ADR 0016](../adr/0016-resolutions-supersession-chain.md)): `/api/admin/resolutions` supports
  `GET`/`POST`/`PATCH`/`DELETE`, all `requireBoard`-gated. `GET` lists every resolution including
  drafts, with no tier filter. `POST` creates a `draft` (`201 { id }`); with
  `{ action: 'adopt', id, effectiveDate, motionId? }` moves a `draft` to `in_force` with a
  mutation-boundary status compare-and-swap; with
  `{ action: 'supersede', id, supersedesId, effectiveDate, motionId? }` puts the (draft) resolution
  `id` in force and marks `supersedesId` `superseded` in one D1 batch that atomically re-checks the
  successor is still a draft, the predecessor is still in force, and no other successor exists.
  Concurrent losers return `409` without a partial transition; with
  `{ action: 'repeal', id }` moves an `in_force` resolution to `repealed`, leaving every
  `supersedes_id` link intact. `effectiveDate` is required by `adopt` and `supersede` and validated
  as a real calendar date (`400` on malformed). `PATCH` edits only `number`/`title`/`body_md`/
  `effective_date`/`visibility` — `status`, `supersedesId`, and `adoptedByMotionId` are
  transition-only and rejected on key presence by `normalizeResolutionInput`, so a chain invariant
  can never be bypassed through a plain field write; `PATCH` also returns `409` if it would clear
  `effective_date` on a non-draft resolution. `DELETE` removes only a `draft` that nothing
  supersedes.
- Board-only elections record (recorded paper elections plus the default-off conducted-election
  lifecycle foundation; see [ADR 0017](../adr/0017-elections-secret-by-construction.md) and
  [ADR 0020](../adr/0020-digital-ballot-box.md)): `/api/admin/elections` supports
  `GET`/`POST`/`PATCH`/`DELETE`, plus actions `open`, `close`, `void`, `setTallies`, `setBallots`,
  `certify`, and `uncertify`, all `requireBoard`-gated. `GET` returns every election including
  drafts and open elections, each with its candidates, turnout, and frozen/current eligibility
  totals nested and, board-only, its per-lot eligibility and ballot lists — the same
  full-detail-on-list shape as `/api/admin/resolutions`. `POST` creates a `draft` election with
  create-immutable `source: 'recorded' | 'conducted'`; `PATCH` edits
  `title`/`seats`/`electionDate`/`meetingId`/`visibility` only — `status`, `source`, and
  certification provenance are transition-only and rejected on key presence by
  `normalizeElectionInput`, and every conducted-election field is frozen after first open.
  `open` accepts only a public- or homeowner-visible conducted draft with at least one
  non-withdrawn candidate
  and one active property while both official mode and the live-voting flag are true; in one D1
  batch it freezes every active property and weight in `election_eligibility` and moves the
  election to `open`. A recorded `close` retains its existing `draft -> closed` transition; a
  conducted close accepts only `open`, atomically moves to `closed`, and derives every candidate's
  final `votes = SUM(ballot_choices.weight)`, using a real zero when no choice row exists. No
  conducted tally is populated or exposed while open, and a closed conducted election cannot
  reopen. `setTallies` and `setBallots` each fully replace their election's candidate-tally set or
  per-lot ballot set in one `db.batch()` (a candidate omitted from `setTallies` has its tally
  restored to `NULL`), and both return `409` for a `certified`/`void` election and for every
  non-`recorded` election. Each replacement reserves the election inside that same D1 batch, so a
  competing certification or void that wins first leaves the existing tallies/ballots intact and
  makes the replacement return `409`. `setBallots` stamps `weight` from
  `properties.vote_weight` unless explicitly supplied, and each entry's `proxyId` goes through the
  same `proxyUseError` guard described in the meetings bullet above, scoped to `{ electionId,
meetingId: election.meetingId, associationDay: election.electionDate }` so a proxy signed for the
  election's own meeting also covers it while grantor authority is evaluated on the election day.
  `certify` (reworked by phase 3b, #218, per #203) takes per-winner
  `{candidateId, personId?, qualifyingLotId, startDay, scheduledEndDay, office?}` and, in one
  reserved `db.batch()`, creates PARTY-ROSTER facts: a `board_service_terms` row per winner
  carrying `election_id`, validated in conditional SQL against the winner's qualifying basis
  (`qualifiesGuard` — the person currently owns or represents the lot) and both non-overlap
  directions, plus an optional `board_office_assignments` row; `candidates.won` is set and the
  election moves to `certified`. It writes NO legacy `board_people`/`board_terms` rows, backfills
  no `candidates.person_id`, and creates NO Access Grant — Board Access is never implicit.
  A winner qualifying nowhere is a hard `409` naming them (the escape is recording the Ownership
  or Representation first), and per-winner `assertInBatch` guards make the whole certification
  roll back rather than commit with a term or an explicitly requested office missing.
  `uncertify` VOIDS the terms it created rather than deleting them — the round-trip leaves
  visible voided facts — voids their office assignments, ends any Board grants they qualified
  (`recorded_in_error`), clears `won`, and returns the election to `closed`; an election
  certified under the retired legacy model simply has nothing to void. `DELETE` removes only a
  `draft` election; a `certified` election cannot be voided directly (`void` returns `409` —
  uncertify first). `/api/admin/candidates`
  supports `POST`/`PATCH`/`DELETE`, `requireBoard`-gated; `sequence` is server-assigned, candidates
  can be added or deleted only while the election is a draft, and conducted candidates become
  immutable after open except that a not-yet-withdrawn candidate may be withdrawn once while open.
  An optional `personId` links a candidate to a party-roster Person — repointed from the retired
  `board_people`/`board_person_id` identity by #248 — and is pre-checked against `people` (rejecting
  an unknown id or one whose Party is consolidated with a readable `400`) before it can reach the
  FK, the same avoid-a-raw-D1-error pattern `setBallots`'s `castByPersonId` check uses.
  The homeowner cast path is `POST /api/vote`, reached only through the feature-gated `/vote` page
  for verified callers. The page renders selection-free receipts that contain only the item title
  and lot address. Its labeled review modal summarizes the pending selection and provenance, moves
  and traps focus, supports Escape/cancel with focus restoration, and disables every background
  voting control. The admin Elections panel separates draft/open Active records from
  closed/certified/void History, exposes conducted Open/Close and count/weight turnout monitoring,
  and never exposes a live conducted tally or editable conducted ballot/choice rows.
- Board-only complete proxies record (including paper proxies entered by the board and online
  grants created by homeowners — one Person authorising one named holder to act for one lot at
  exactly one meeting or election; see
  [ADR 0018](../adr/0018-proxies-record-via-proxy-consolidation.md)): `/api/admin/proxies`
  supports `GET`/`POST`/`PATCH`/`DELETE`, all `requireBoard`-gated. `GET` returns every proxy with
  its property address and grantor/holder names resolved — the same full-detail-on-list shape as
  `/api/admin/resolutions` and `/api/admin/elections`; the member sibling described below is
  lot-scoped rather than a complete register. `POST` returns `201 { id }` with a readable `404` for
  each of the five FKs it
  can write (`propertyId`, `grantorPersonId`, `holderPersonId`, `meetingId`, `electionId`), `400` if
  the grantor has NEVER held Lot Authority over the given property — deliberately the weaker of the
  two questions `roster/authority.ts` answers, since a proxy signed before a sale is a real record
  the board must be able to enter; `proxyUseError` decides whether that proxy was effective on its
  occasion day (ADR 0018's entry/use split, preserved by #248 part 2 rather than tightened) —
  `400` if grantor and holder resolve to the same person,
  `409` if `meetingId` resolves to a board-body meeting ("Proxies apply to member meetings —
  this is a board meeting" — proxies are cited only by member attendance/votes/ballots, so a
  board-meeting proxy could never be used; election occasions are unaffected), and `409` on a
  duplicate occasion (`proxies_property_meeting_unq`/`proxies_property_election_unq`, "This lot
  already has a proxy for this occasion"). `PATCH`
  allow-lists `holderName`/`holderPersonId`/`grantorPersonId` — `propertyId`, `meetingId`, and
  `electionId` are rejected on key presence by `normalizeProxyInput`, since moving a proxy to
  another lot or occasion is a different proxy, not an edit — and re-checks grantor-≠-holder against
  the effective stored-plus-payload values. `DELETE` returns `409` naming which of `attendance`,
  `votes`, or `ballots` still cites the proxy ("Proxy is in use (…) — remove those records first"),
  else deletes; deletion is the entire revocation model, there is no `revoked_at`.
- Official-mode homeowner proxies: `/api/member/proxies` supports `GET`/`POST`/`DELETE`, and
  `/api/member/owner-lookup` supports `POST`. Every handler calls `requireMemberApi`, while
  middleware independently gates `/api/member/*`: `officialMode` off returns `404`, then anonymous
  is `401` and callers below `homeowner` are `403`; board callers pass the rank check. `GET` returns
  only proxies granted for the caller's verified lots plus proxies naming a Person with authority
  over one of those lots as holder. Own-lot rows retain occasion title/date even above the caller's
  tier; held rows for another lot redact those fields above tier. `POST` requires one
  caller-controlled lot, a Person currently holding Lot Authority there as grantor, a different
  Person holding authority somewhere as holder, and exactly one
  visible upcoming member meeting or non-terminal election. Both the picker read and write path
  expose only minimal scheduled-occasion metadata at the occasion's visibility tier even while its
  record remains draft; dates use the `America/New_York` association day. `DELETE` is limited to
  the caller's lots and refuses both past occasions and proxies already cited by attendance, votes,
  or ballots. The address lookup resolves one typed active-property address to the names and opaque
  IDs of the Persons who may act for it (never contact data) — repointed from the lot's active
  `owners` rows by #248 part 2, which also makes an Organization's Representative nameable where
  the legacy shape could only offer the entity; the route keeps its `owner-lookup` path, since #248
  changed what it reads rather than where it lives. Verified homeowners can repeat such lookups, an
  accepted disclosure documented with the lot-control/self-asserted-owner trust model in
  [ADR 0019](../adr/0019-homeowner-writes-official-mode-gate.md).
- Board-only duplicate review: `GET /api/admin/duplicates` lazy-backfills document hashes from R2
  and returns exact or near groups, each member annotated with a `verifiedAt` timestamp; groups
  where every member is already kept-verified are hidden until a matching upload resets one.
  `POST /api/admin/duplicates` takes `{ action: 'resolve', keepIds, deleteIds }`, deletes each
  `deleteIds` document (D1 row + R2 object), and marks the surviving `keepIds` as kept-verified;
  `keepIds` must be non-empty and disjoint from `deleteIds`, while `deleteIds` may be empty for a
  keep-all/mark-reviewed resolution.
- Board handoff, re-pointed by ADR 0022 phase 3e (#221) onto the same `cutover_mode` branch
  `/api/verify/*` established: `GET /api/admin/roles` lists current board; `POST /api/admin/roles`
  accepts `{ action: 'promote', email }` or `{ action: 'demote', userId }`. Under `legacy` both
  actions write `users.role` exactly as before — `demote`'s last-board-member count-then-update race
  is now closed by folding the live-board-count check into the update's own `WHERE` (a lost race
  answers `409` rather than emptying the board), and the historical `409` for demoting anyone while
  only one board member remains is preserved bit-for-bit. Under `derived`, `promote` instead walks
  account → Person Link → a current-or-scheduled Board Term and creates a `board` Access Grant plus
  a `users.role` write-behind mirror in one batch (readable `404`/`409` naming whichever link is
  missing or already granted), and `demote` ends every live Board grant the account holds, refusing
  (`409`) if that would leave no other account holding Board Access, then mirrors the role the
  account derives to afterward — `homeowner` if Lot Authority survives, `visitor` otherwise, `board`
  if a live `system_admin` grant remains. The shared builders (`grantStatements`,
  `endBoardGrantsStatements`, and the chain/mirror reads) live in the new
  `src/server/roster/access.ts`, called by both this route and `/api/admin/access-grants` so the two
  surfaces can never write different grants.
- Member revocation, also re-pointed by phase 3e: `GET`/`POST /api/admin/members` lists recently
  verified homeowners plus the legacy manual-approval queue (write-dead since v0.10.0 — nothing
  enqueues to it in either cutover mode; its `approve`/`deny` actions stay legacy-queue-only and
  unbranched). `POST { action: 'revoke', userId }` ends a homeowner's access: under `legacy` it
  clears `users.role` to `visitor` and deletes the account's `user_property_links`, refusing (`409`)
  a current board member exactly as before; under `derived` it ends the account's Person Link via
  the shared `endLinkStatements` (reason `no_longer_qualifies`), writing the same
  `users.role`/`user_property_links` mirrors in the same batch, and decides the board-member
  refusal from live Board grants — never from the mirror it is itself writing.
- ADR 0022 phase 2 roster preview, `requireBoard`-gated and read-only:
  `GET /api/admin/roster-preview` returns structural counts (IDs and non-personal fields only, not
  a roster browser) across five sections — Roster, Board, Access, Review, Compliance — including
  the two ADR 0022 integrity views and shadow-mismatch counts. It is not a public or homeowner
  surface and does not affect authorization. Its phase-2 admin panel (`RosterPreview`) was retired
  by phase 3e in favor of the five writable panels below; this route and its structural-count shape
  are unchanged.
- ADR 0022 phase 3b roster, board-service, and access routes (#218; decided by #202/#203/#205 —
  read those resolution comments before touching any of this). Every mutation here is ONE D1 batch
  of conditional statements — domain writes first, then the immutable-ledger rows built by
  `src/server/roster/audit.ts`'s `AuditCorrelation` (one command = one correlation; root event
  seq 0 with a unique `operation_key`; consequences name the root as cause), every statement gated
  so a lost race leaves ZERO rows anywhere, with `meta.changes` on the primary deciding the `409`.
  Since the phase 3f flip these routes write the roster production actually runs on, and the
  authoritative backfill that seeded it is insert-once, so the clean-replace mode that once could
  have erased their rows is permanently retired. The surfaces, all `requireBoard`-gated unless
  noted:
  - `/api/admin/board-service` — `GET` (terms + offices + live-derived composition advisories:
    below-three/above-five, vacant offices, expiring and lapsed terms) and a `POST` action bus
    with NO `PATCH`: `createTerm`, `endTerm`, `cancelTerm`, `voidTerm` (the three disjoint ending
    kinds), `substituteQualifyingLot` (in-place, three typed subjects), `correctTerm`,
    `assignOffice`, `endOffice`, `voidOffice`. Interval non-overlap per Person AND per qualifying
    Lot is conditional SQL at the mutation boundary (`noOverlapGuard`), proven under interleaving;
    ending a term ends its current offices and its Board grants (the grant always at recorded-at).
  - `/api/admin/access-grants` — `grant`/`revoke` for both grant types. Board callers act on
    `board` grants (their own included); `system_admin` grants take a System Administrator. The
    last-System-Administrator invariant lives on exactly this route as a mutation-boundary guard
    (never in evaluation), re-checked inside the batch so concurrent revokes cannot empty the set,
    and a refused attempt is permanently recorded as a denied Access Event. Grants validate the
    account→Person-Link→term chain and are created only through this route's explicit `grant`
    action or, as of phase 3e (#221), the board-handoff `/api/admin/roles` `promote` action under
    `derived` — both call the same `grantStatements` builder in `src/server/roster/access.ts` —
    never implicitly by anything else.
  - Roster: `GET /api/admin/roster` (full-detail Roster surface with the live Ownerless-Lot
    advisory; single-record reads never write the ledger) plus per-entity `POST` action buses —
    `/api/admin/roster-lots` (`retire` — ends current Ownerships as caused Roster Changes,
    dual-writes legacy `properties.status`, refuses over a live qualifying term or an open frozen
    snapshot; `correctRetirement` restores the Lot but never the ownerships), `/api/admin/
roster-parties` (`createPerson`/`createOrganization` — party+subtype in one batch, org name
    collisions warn rather than merge; name corrections; `consolidate` with an explicit survivor,
    same-kind/one-hop/both-linked refusals; `correctConsolidation` clears the pointer),
    `/api/admin/roster-ownerships` (`create` — no anticipated start OR end; `end` — backdated
    end day allowed, with optional per-affected-term `substitutions` else terminate-by-default via
    `src/server/roster/board-consequences.ts`, then the phase 3d transfer-effects engine below;
    `void` — no vote reset, supersede-on-void of that Ownership's own open flags),
    `/api/admin/roster-representations`
    (`create` — scope XOR, scoped lots must be currently org-owned, end day MAY be future; `end`;
    `void`; `correctScope` — scope rows void, never delete; `end`/`void`/`correctScope` each also
    run the phase 3d transfer-effects engine, discovery-only), and `/api/admin/
roster-contact-methods` (`add`/`end`/`void`/`setPreferred`; values normalize on write and
    reach the ledger as sensitive-field CATEGORIES only).
  - `POST /api/admin/roster-export` — the bulk export, deliberately a mutating verb: it is the one
    read that is also a recorded act, writing an `access` ledger event (`roster_export`) BEFORE
    any data leaves and failing closed (500, no export) if the record cannot be written. Nothing
    is persisted server-side.
  - `GET`+`POST /api/admin/correction-requests` — the board review queue for member correction
    requests; `accept` applies the fact as an ordinary Roster Change citing the request id as
    opaque evidence (`evidence_request_id`); `decline` writes no ledger row.
  - The three System-Administrator-only surfaces, gated by `requireApiCapability` on the four
    technical capabilities (#205/#217): `/api/admin/redactions` (`redactPersonName`/
    `redactContactMethod` under `redactionAuthorize` — value and marker nulled together, at least
    one `redaction_tasks` row always created so the integrity view holds; `recordCleanup` under
    `redactionCleanup`, operational only), `GET /api/admin/access-denials`
    (`accessDenialDetail`), and `GET /api/admin/audit-integrity` (`auditIntegrityViews`). These
    capabilities come only with a live `system_admin` grant, so under `derived` they answer only
    the System Administrator (one exists since the phase 3f bootstrap) and 403 everyone else; if
    the flag were ever written back to `legacy`, nobody holds them and all three answer 403 for
    every caller — by design.
  - Member correction requests: `GET /api/member/roster-self` (own Person, Contact Methods,
    Ownerships, Representations, open requests — never the ledger, never another party's data)
    and `GET`/`POST`/`DELETE /api/member/correction-requests` (own name and own Contact Methods
    only; requests are operational rows whose free text NEVER enters the ledger; withdrawal and
    out-of-scope ids mask as `404`). Both use `requireMemberApi` and then answer the deliberate
    no-Person-Link `403` pointing at verification — under `derived` that is any caller whose
    account has not been linked to a Person; under `legacy`, which has no Person concept, it is
    every caller.
- ADR 0022 phase 3c Person Verification / Person Link routes (#219; decided by #201, amended by
  #202). `/api/verify/{request,confirm}` are now ONE route contract answered by TWO backends
  branched on `getCutoverMode`: `legacy` keeps the existing property flow (address match,
  owner-contact fan-out, `property_verifications`, confirm writes `user_property_links` and
  promotes role); `derived` runs the new Person flow entirely in `src/server/roster/verification.ts`.
  `POST /api/verify/request` takes `{ address, name, channel, turnstileToken }` in both modes;
  after the write freeze, session, malformed-body, channel, and Turnstile gates — none of which
  touch the roster — EVERY remaining outcome (success, unknown address, unmatched or ambiguous
  name, an organization-owned lot, a shared/unattributable contact, both already-linked
  collisions, and every rate limit) converges on the same byte-identical
  `200 { ok: true, message: 'If the information matches our records, a code has been sent.' }`;
  there is no more `queued`/`rateLimited` distinction and no `429` on this route. Under `derived`,
  the matcher (`matchPersonForVerification`) resolves the claimed Lot, filters current Person
  owners (never Organizations — the join through `people` excludes them structurally), applies a
  two-tier name match (exact normalized full match; if zero, a first-and-last-token match; either
  tier requires exactly one candidate), then picks the matched Person's current contact on the
  chosen channel that is ALSO uniquely attributable roster-wide (`(channel, value_normalized)`
  resolves to exactly one Party), and sends exactly one code to that contact — never a fan-out. A
  Person already linked to a different account auto-creates a `verification_review_requests` row
  (`internal_reason='person_already_linked'`) and sends nothing; the caller's own account already
  being linked sends nothing and creates nothing. `POST /api/verify/confirm` collapses every
  internal failure (wrong code, expired, locked, or a batch race) into
  `{ ok: false, reason: 'mismatch' }` except `expired`/`locked`, which keep their own reason; on a
  `derived` success it writes, in one D1 batch, `person_verifications`
  (`method='otp_email'|'otp_sms'`), `person_links`, a root `identity`-family ledger event
  (`person_verified`, reason `automatic_contact_proof`), and two write-behind mirrors (never read
  for authorization) that insert `user_property_links` and promote `users.role` from `visitor` to
  `homeowner` — kept only so the legacy read model and Better Auth session stay coherent through
  the flip. Neither backend auto-queues to `manual_approval_queue` anymore — the three legacy
  auto-enqueue paths (address not found, no contact on file, every send failed) were removed;
  `POST /api/verify/review` is the one explicit applicant action that queues review (session-gated,
  no Turnstile — the one-open-request-per-account partial unique index is the flooding control),
  writing `verification_review_requests` identically in both modes and always answering the
  uniform `200 { ok: true, message: 'Your request was sent to the board.' }`.
  `POST /api/verify/unlink` is the applicant's always-available self-unlink — deliberately outside
  `/api/member/*` and `officialMode`, gated only by the write freeze and an authenticated session —
  ending the caller's own Person Link and every Access Grant it currently supports in one batch,
  refusing (`409`) to strip the last System Administrator and permanently recording that refusal
  as a denied Access Event. The board's mirror surfaces are flat, `requireBoard`-gated, and
  new-model-always (no mode branch): `/api/admin/person-links` (`GET` the full link register with
  verification provenance; `POST` `manualVerify { accountId, personId, reason:
'manual_board_decision'|'migration_reverification', evidence }` links an EXISTING Person — never
  creates one — with readable `404`/`409` pre-checks for an unknown/organization/consolidated
  Person or either side already linked, and `unlink { linkId, endReason }` for every admin-facing
  end reason except `self_unlink`, sharing the same grant-ending batch and last-System-
  Administrator guard as `/api/verify/unlink`) and `/api/admin/verification-requests` (`GET` the
  open review queue; `POST` `accept { id, personId, reason? }` is a `manualVerify` whose evidence
  cites the request's own id, resolving the row `accepted` in the same batch; `decline { id }`
  marks the row `declined` and writes a durable `identity` ledger event — denial IS ledgered here,
  unlike a correction-request decline). Rate limiting (KV, `src/server/verification/rate-limit.ts`)
  keeps Turnstile, the per-account 120s cooldown, and the per-account daily cap (5), keeps the
  per-Lot daily cap (5, both modes), adds a per-Person daily cap (5, `derived` only — a Person who
  owns several Lots must not be re-sendable once per Lot), and adds a distinct-claimed-names-
  per-Lot-per-account cap (3/24h, both modes) — the roster-walking control, capping how many
  different names one account can try against one Lot regardless of whether any of them matched.
- ADR 0022 phase 3d transfer effects and the review-flag queue (#220; decided by #204).
  `src/server/roster/transfer-effects.ts` is the mutation-boundary engine wired into
  `/api/admin/roster-ownerships` `end` (resets every open member-motion vote for the departing
  Lot, then runs retrospective discovery and the forward pass) and `void` (no vote reset — a void
  is not a transfer — plus supersede-on-void of that Ownership's own open flags) and into
  `/api/admin/roster-representations` `end`/`void`/`correctScope` (discovery and the forward pass
  only; a Representation change never resets a vote). Per #204, a transfer changes who may act for
  a Lot, never whether the Lot counts: no eligibility snapshot, weight, turnout row, or quorum
  denominator is touched. The ONE stored action it reverses is an open member-motion vote for the
  transferred Lot — `member_votes` deleted and the motion's `voting_revision` advanced under the
  same compare-and-swap `setMemberVotes` and live casting already require, closed motions
  untouched. Everything else is surfaced, never rewritten, as a `review_flags` row: retrospective
  discovery walks the `[effectiveDay, recordedAt]` window (occasion-day rule for member
  attendance/votes, recorded-instant rule for ballots and granted proxies) and flags
  `intervening_action_backdated`, plus an account-keyed pass over `roster_change`/`identity`
  ledger events for any Board Term the command affected; a forward pass over still-upcoming
  occasions flags a pending held proxy `authority_lost_pending_occasion` and a not-yet-concluded
  conducted ballot `ballot_final_after_transfer` (conducted only — a recorded election's ballots
  stay replaceable via `setBallots`). One flag per record: the forward pass is enumerated first and
  wins any record both passes would reach. A void supersedes its own open flags
  (`resolution_code = 'superseded'`) rather than deleting them; nothing stored is ever reversed.
  Flag INSERTs FK-reference the `review_flag_opened` audit event that opens them, so
  `effects.flagStatements` runs after `correlation.statements` in every caller's batch — the one
  documented exception to `audit.ts`'s domain-writes-first ordering. BALLOT SECRECY: this module
  never reads, joins, names, or counts `ballot_choices` or a candidate selection — a
  `ballot_final_after_transfer` flag reaches only the identity-linked turnout `ballots` row and the
  election occasion. The board's read/resolve surface is `GET`+`POST /api/admin/review-flags`,
  `requireBoard`-gated: `GET` returns the full-detail register (every flag, open first, with its
  typed impacted reference and source-event summary — the same full-detail-on-list shape as the
  other phase-3b/3c registers); `POST { action: 'resolve', id, resolutionCode }` accepts
  `remediated`/`confirmed_valid`/`no_effect` (`400` for `superseded`, reserved for the automatic
  void/correction path above; `409` on an already-resolved flag) and, in one batch, flips the flag
  and writes an account-attributed `review_flag_resolved` root event. `src/lib/roster-admin.ts`'s
  `fetchReviewFlags`/`resolveReviewFlag` and the phase-3e (#221) **Review** panel (`ReviewPanel`)
  are its client helper and admin panel: `ReviewPanel` lists every flag with its typed `impacted`
  reference (rendering `null` rather than hiding the row), offers only the three manual resolution
  codes, and never offers `superseded`.
- Board-only document assistant: `POST /api/admin/assistant` (SSE) takes `{ question, history? }`
  and streams a Claude-generated, cited answer over the document library, retrieved via Cloudflare
  AI Search; document excerpts and chat history are pseudonymized (known resident PII replaced with
  consistent surrogates) before they reach Anthropic, document titles are pseudonymized before being
  sent, orphan/empty retrieval chunks are dropped before generation, and citations reference
  retrieved chunks back to real documents server-side. See SECURITY.md for the
  pseudonymization guarantees and limits. Retrieval is not tier-aware, which is why this endpoint
  stays board-only — see SECURITY.md and [`data-model.md`](./data-model.md) for the two-representation R2 layout
  retrieval runs over. `POST /api/admin/documents` generates the document's `rag/<uuid>.md` twin on
  upload via Workers AI `toMarkdown` and records `documents.rag_status` (`ok`/`unsupported`); a new
  upload is searchable at the next AI Search sync, and files that cannot be converted (scans, old
  `.doc`) are flagged "Not searchable" in the admin Documents panel via a board-only
  `GET /api/admin/documents`. Scanned uploads that `toMarkdown` cannot convert are flagged
  `rag_status = 'unsupported'` and can be made searchable later by the operator-run
  `scripts/ocr-scanned.ts` (rasterize + Workers AI vision; see [ADR 0010](../adr/0010-ocr-scanned-documents-operator-job.md)).
- Board-only governing-documents reports: `POST /api/admin/reports` (SSE) takes `{ template }` XOR
  `{ topic }` (topic capped at `INPUT_LIMITS.reportTopic`; 400 on malformed/both/neither/
  unknown-template/over-length, 422 when retrieval yields no usable excerpts before any report
  generation call, 500 when the Anthropic key is missing, 503 when AI Search is unavailable). One
  of six curated templates (rentals, fences/improvements, assessments,
  enforcement, meetings/voting, maintenance) supplies fixed retrieval sub-queries; a freeform topic
  is instead expanded into 3-6 sub-queries by a small Claude Haiku structured-output call. Chunks from every
  sub-query are retrieved, pooled, deduped, and capped at 30, then streamed through one Claude Opus
  generation into a five-section markdown report (Summary / What the documents say / Where it
  lives / Ambiguities and conflicts / Gaps) with `[Source N]` citations, built via the same
  excerpt-context and pseudonymization pipeline as the chat assistant (see `src/server/ai/`
  below). The stream emits a `sources` frame, `token` frames, then `done { id }`; a completed
  report is inserted into the `reports` table before `done` is emitted, so a failed or
  client-disconnected generation leaves no row. `GET /api/admin/reports` lists saved report
  metadata newest-first in an `{ items, nextCursor }` envelope (`limit` defaults to 20 and is capped
  at 100; pass the opaque `cursor` to continue), or returns one full report (`?id=`) including
  `contentMd` and sources;
  `DELETE /api/admin/reports` (body `{ id }`) removes a saved report. All three verbs are
  `requireBoard`-gated, fail-closed. Saved de-anonymized text and source metadata are purged after 90
  days and atomically with any roster name/contact redaction; the row's ID, template, creator, and
  timestamp remain. See SECURITY.md for the privacy model shared with the chat assistant.
- Homeowner verification: `/api/verify/{request,confirm,review,unlink}` — see the ADR 0022 phase
  3c entry above for the full contract.
- First-System-Administrator bootstrap: `POST /api/bootstrap/board` (rewritten by #219; see
  `src/server/roster/bootstrap.ts`), permanently fail-closed and checked in this order: the
  `system_admin_bootstrap` singleton is unconsumed (`410` once used — this, not "does a board
  account exist," is the primary guard, since an account can also be promoted board by other
  means), a timing-safe `x-bootstrap-secret` match against `env.BOOTSTRAP_SECRET` (missing binding
  = closed, `403`), an authenticated session (`401`, resolved directly off Better Auth rather than
  through `getAuthContext`/`cutover_mode`, since bootstrap runs at flip step 4 while `cutover_mode`
  may still read `legacy`), then a body `{ personId }` naming an already-recorded roster Person
  (readable `404`/`409` for unknown/organization/consolidated or either side already linked). One
  atomic batch then creates `person_verifications` (`method='bootstrap'`,
  `reason='bootstrap_first_administrator'`), `person_links`, a `system_admin` row in
  `access_grants` (`grant_reason='bootstrap'`), the `system_admin_bootstrap` singleton row itself,
  a root `identity` ledger event plus its caused `access` event, and a `users.role='board'`
  write-behind mirror (fresh-deploy admin access under `legacy`; a no-op if the account is already
  board at the flip). The legacy BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME signup path and its
  board-count guard are retired — `src/server/auth/seed-board.ts` and `scripts/seed-board.ts` are
  deleted. The route stays at its unchanged path and remains one of the write freeze's two
  permanent exemptions; it never calls `writeFreezeError`.
- Better Auth handler: `/api/auth/[...all]`.
