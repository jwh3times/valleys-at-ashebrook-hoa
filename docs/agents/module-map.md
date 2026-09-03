# Module map

What lives where in `src/lib/` (browser-reachable helpers) and `src/server/` (server-only logic),
and the non-obvious constraints attached to each. This is a map, not an index — it names the
modules whose purpose or boundary is not evident from the filename, and skips the rest.

The boundary itself is the rule: **server-only code stays in `src/server/` and is never imported
into a client-side module.**

## Client helpers (`src/lib/`)

- `src/lib/content.ts` handles public reads from `/api/content/*` endpoints.
- `src/lib/member.ts` handles the official-mode homeowner proxy API: `fetchMyProxies`,
  `grantProxy`, `revokeProxy`, and `lookupLotPersons` (over the unchanged `/api/member/owner-lookup`
  path), with the write/lookup request shapes kept beside those helpers.
- `src/lib/admin.ts` handles board writes to `/api/admin/*` endpoints, typed document duplicate
  errors, duplicate-resolution helpers, saved-report list/fetch/delete helpers (`fetchReports`,
  `fetchReport`, `deleteReport`), the meeting-record people-picker and party-roster reads that
  replaced the retired board-roster helpers (`fetchMeetingRosterPeople` — the flat `{id,
fullName}` list from `GET /api/admin/meetings?roster=people` — plus `fetchLotPeople`, the per-lot
  Lot Authority list from `GET /api/admin/meetings?roster=lot-people` that backs the member
  attendance, member vote, ballot, and proxy pickers (#248 part 2; former holders included and
  flagged `current: false`, so a past occasion stays recordable and the Proxies panel can warn that
  a grantor's proxy would be born unusable), and `fetchRosterPeople` and
  `fetchRosterLots` over `GET /api/admin/roster`), meeting-record helpers
  (`fetchMeetings`, `fetchMeeting`, `saveMeeting`, `deleteMeeting`, `approveMeeting`,
  `unapproveMeeting`, `setAttendance`, `setMemberAttendance`, `saveMotion`, `deleteMotion`,
  `openMotionVoting`, `closeMotionVoting`, `setVotes`, `setMemberVotes`), resolutions-book helpers (`fetchResolutions`,
  `saveResolution`, `deleteResolution`, `adoptResolution`, `supersedeResolution`,
  `repealResolution`), and elections-record helpers (`fetchElections`, `saveElection`,
  `deleteElection`, `openElection`, `closeElection`, `voidElection`, `certifyElection`, `uncertifyElection`,
  `setTallies`, `setBallots`, `saveCandidate`, `deleteCandidate`) — the board-only `GET` for
  resolutions, elections, and proxies already returns every record's full detail, so unlike
  meetings/motions none of them has a separate single-record fetch — and proxies-record helpers
  (`fetchProxies`, `saveProxy`, `deleteProxy`). `setMemberAttendance`, `setMemberVotes`, and
  `setBallots` each take a `proxyId?: string | null` per entry, replacing the old `viaProxy?:
boolean`.
- `src/lib/roster-admin.ts` (ADR 0022 phase 3e, #221) handles board — and, for its three
  System-Administrator-only actions, capability-gated — writes to every phase 3b/3c/3d roster admin
  surface, one group per admin panel: Roster (`fetchRoster`, lot retire/correct, party
  create/correct/consolidate, ownership create/end/void, representation
  create/end/void/correctScope, contact-method add/end/void/setPreferred, `exportRoster`), Board
  (`fetchBoardService` plus the nine create/end/cancel/void-term, substitute-qualifying-lot,
  correct-term, and assign/end/void-office actions), Access
  (`fetchAccessGrants`/`grantAccess`/`revokeAccess`,
  `fetchPersonLinks`/`manualVerifyPersonLink`/`unlinkPersonLink`, and the
  verification-review/correction-request queue helpers), Review
  (`fetchReviewFlags`/`resolveReviewFlag`), and Compliance
  (`fetchRedactions`/`redactPersonName`/`redactContactMethod`/`recordRedactionCleanup`,
  `fetchAccessDenials`, `fetchAuditIntegrity`). `isCapabilityRefusal` identifies the bare `403`
  every System-Administrator-only helper returns to a caller holding no live `system_admin` grant
  — which, while `cutover_mode = legacy`, is every caller. The five admin
  panels (`RosterAdminPanel`, `BoardServicePanel`, `AccessPanel`, `ReviewPanel`, `CompliancePanel`)
  call only these helpers, never the routes directly.
- `src/lib/voting.ts` handles the exact-204 browser writes to `POST /api/vote` for one-time
  homeowner election-ballot and member-motion submissions; failed responses surface their server
  message and never create a receipt.
- `src/lib/reports.ts` contains the six curated `REPORT_TEMPLATES` (rentals, fences/improvements,
  assessments, enforcement, meetings/voting, maintenance) with their hand-tuned retrieval
  sub-queries, pagination constants, and the shared `ReportPage`/`ReportListItem`/`ReportDetail`/
  `ReportSource` shapes used by both the admin UI and the `/api/admin/reports` endpoint.
- `src/lib/types.ts` contains shared shapes, `DEFAULT_*` fallbacks, `DOCUMENT_CATEGORIES`, the
  `Visibility` type, fail-closed `SiteSettings.liveVotingEnabled`, admin-write input normalizers
  (`normalize{Announcement,Property,Owner,Resolution,Election,Candidate,Proxy}Input`,
  `INPUT_LIMITS`) that trim, cap, validate, and reject on write, the resolution shapes
  (`ResolutionStatus`, `RESOLUTION_STATUSES`, `ResolutionSummary`, `ResolutionDetail`,
  `ResolutionChainLink`, `ResolutionInput`), the elections shapes (`ElectionStatus`,
  `ElectionSource`, `ELECTION_STATUSES`, `ELECTION_SOURCES`, `ElectionSummary`, `ElectionDetail`,
  `CandidateSummary`, `ElectionTurnout`, `ElectionEligibleProperty`, `BallotRow`, `ElectionInput`,
  `CandidateInput`), member-motion `MotionVotingState` and shared `EligibilityTotals`, the
  caller-specific voting read shapes (`OpenVotingItem`, `OpenElectionVoting`, `OpenMotionVoting`,
  `VotingLot`, `VotingPersonOption`, `VotingProxyOption`), cast inputs/results (`VoteAction`,
  `CastBallotInput`, `CastMotionVoteInput`, `VoteWriteResult`), the proxies shapes (`ProxyDetail`,
  `ProxyInput`, `MemberProxyDetail`, `MemberProxyLists`, `MemberLot`, and `UpcomingOccasion`), a shared
  `isoDateOrError` calendar-date validator used by both the declarative normalizers and the
  resolutions route's `adopt`/`supersede` and the elections route's `certify` transition
  arguments, and `MemberAttendanceRow`/`MemberVoteRow`/`BallotRow`'s `proxyId` field (board-only,
  `null` on every public read — `viaProxy` on all three is now derived as `proxyId !== null` rather
  than a stored column).
- `src/lib/site.ts` contains branding constants and official-mode presentation logic (`navLinks`,
  `brandTag`, `accountNav`). The footer disclaimer and `/about` copy are board-editable via site
  settings, with `DISCLAIMER_SHORT` and `DISCLAIMER_LONG` as fallbacks. `disclaimer(site)` and
  `aboutParagraphs(site)` return overrides or built-in copy when blank. This is a pure module usable
  in `.astro` files, islands, and unit tests.
- `src/lib/format.ts` contains shared formatting helpers, including `associationDateIso` for the
  `America/New_York` proxy cutoff, unit-tested in `format.test.ts`.
- `src/lib/auth-client.ts` contains the Better Auth browser client.

## Server code (`src/server/`)

`src/server/` contains:

- `auth/`: Better Auth config, Resend and Twilio senders. **Better Auth cannot be upgraded past
  1.6.x right now** — 1.7 throws `BetterAuthError("Secondary-storage rate limiting requires
SecondaryStorage.increment.")` from `onRequestRateLimit` on every request whenever rate limiting
  resolves to secondary storage and the adapter has no `increment`. This config enables
  `rateLimit: { enabled: true, window: 60, max: 100 }` and passes the `KV` binding through to
  `better-auth-cloudflare`, whose `createKVStorage` implements no `increment` — and 0.3.1 is that
  package's latest published release, so there is no upstream fix to bump to. Verified against
  1.7.0: 6 tests in `test/server/auth-handler.test.ts` and `test/server/admin-surface-closed.test.ts`
  fail on 1.7.0 and pass on 1.6.29; in production this would break sign-in, sign-up, and password
  reset, not just tests. The escape routes — supplying `rateLimit.customStorage` (checked before
  the secondary-storage path) or wrapping the KV secondary storage with an `increment` — are each a
  security-sensitive change to auth rate limiting and belong in their own reviewed change, not a
  dependency bump. `.github/dependabot.yml` therefore IGNORES better-auth minor and major updates,
  so 1.7.x is no longer re-proposed into the `npm-minor-and-patch` group (where it blocked four
  safe bumps in #255); 1.6.x PATCHES still come through, so a fix on the current line is not
  suppressed. Remove that ignore entry, and this note, once one of those routes is taken (#260).
- `authz/`: `context.ts` is the single seam every guard, page, and route resolves its caller
  through. `getAuthContext(request, env, associationDay)` resolves the session, then reads
  `cutover-mode.ts`'s `getCutoverMode` (the uncached `cutover_settings.cutover_mode` singleton,
  `test/server/cutover-mode.test.ts`) to decide which model answers: `legacy` calls
  `legacyAuthContext`, which synthesizes an `AuthContext` from the stored `users.role`/
  `user_property_links`, deliberately reproducing the old rank ladder (a board caller gets `member`
  too) so `cutover_mode = legacy` is bit-for-bit what the site was; `derived` calls
  `derivedContext(deriveAccess(...))` (below). `getCutoverMode` fails closed to **`legacy`** — the
  opposite polarity from the write freeze below, deliberately: the freeze falls back to frozen
  because refusing is the restrictive answer, while the safe answer here is whichever model is
  already serving production. Since the phase 3f flip the row exists and reads `derived`; an
  absent row now means the singleton was never written, and answers `legacy`. `associationDay` is a
  required third parameter, computed once per request by `src/middleware.ts` and by
  `resolveAuthContext` (middleware-first caller resolution with a fail-closed fallback) via
  `associationDateIso()`, never read from `locals` or recomputed downstream.
  `readLegacyRosterContext` reads the legacy answer for one account entirely from D1 with no
  session, for the shadow layer's mode-aware comparison (below). `users.role` is read ONLY inside
  `context.ts` — `test/unit/authz-legacy-role.test.ts` pins that by import-scanning the rest of
  `authz/`, and separately scans all of `src/` for a `ctx.role` comparison outside the guards (a
  read like `visibleTiers(ctx.role)` passes the alias onward rather than comparing it, so it is not
  matched). `guards.ts` defines the `AuthContext` shape — `userId`, `personId` (null under
  `legacy`, which has no Person concept), a `capabilities` **set** of `member`/`board`/
  `systemAdmin` (deliberately not a ladder: `systemAdmin` implies `board`, but neither implies
  `member`, which comes only from Lot authority), `lotIds`, `contentTier`, `hasCurrentBoardTerm`,
  plus compatibility aliases `role` (= `contentTier`) and `propertyIds` (= `lotIds`) that feed
  nothing but content reads — `tierAllows`/`visibleTiers` and their call sites are unchanged —
  retained through phase 3 and deleted in phase 4 (#212) — and its two check primitives:
  `requireCapability(ctx, capability)` (set membership, the primitive every route gate is now built
  on) and `requireRole` (survives only for content-tier questions, since `contentTier` is
  genuinely ordered, unlike capability). `requireBoard`, `requireMemberApi` (official-mode-first
  homeowner-write gate), and `requireVotingApi` (feature flags, write freeze, exact Origin, JSON
  media type, session, then `member` capability, in that order) keep their signatures but now gate
  on `ctx.capabilities` — `board` for the admin gate, `member` for the member and voting gates — as
  does middleware's backstop for each surface. Four call sites that used to compare `ctx.role`
  directly now ask `ctx.capabilities.has(...)`/`ctx.lotIds` instead: `/api/member/owner-lookup`,
  both cast preflights in `content/voting.ts`, and the `verified` checks on `/proxies` and `/vote`
  — identical behavior under `legacy`; under `derived`, a board member who owns no Lot is refused
  these member surfaces while still admitted to board ones. `requirePropertyAccess` remains the
  per-property access check (no route calls it yet), and Turnstile checks are unchanged.
  `write-freeze.ts` (`isWriteFrozen`, `writeFreezeError`, `freezePolicyFor`,
  `isMutatingMethod`) is the operator-only maintenance switch built for the ADR 0022 phase-3 flip
  and retained after phase 4: it reads the uncached `cutover_settings.write_freeze` singleton
  (fail-closed — a read error or an active freeze answers `503`; an absent row is the normal
  un-frozen state, not an error). Coverage is **deny-by-default and path-derived**:
  `freezePolicyFor(path)` is the single authority both enforcement layers consult, returning
  `everything` for `/api/member/*` and `/api/vote` (no read-only half worth keeping live),
  `exempt` for exactly two paths, and `mutations` for **everything else** — including paths nobody
  has written yet. `writeFreezeError(env, request)` therefore takes no scope argument: it derives
  coverage from the request's own path, so no call site can hold a stale opinion about what its
  surface freezes, and middleware and the per-route guards cannot drift. The two exemptions are
  `/api/auth/*` (sign-in writes a session row; an operator locked out of `/admin` cannot run the
  flip) and `/api/bootstrap/board` (flip step 4 creates the first System Administrator while the
  freeze is on). Called from `requireBoard`, `requireMemberApi`, `requireVotingApi`, both
  `/api/verify/*` routes, and `src/middleware.ts` — whose final `else` branch is what catches any
  surface no named branch claims. `test/unit/freeze-coverage.test.ts` enumerates every route module
  and fails if a mutating route ends up live without being declared in both that test and
  `ALWAYS_LIVE`. `authz/` also holds the ADR 0022 shadow layer, which computes but never decides:
  `derive.ts` (`deriveAccess`/`toDerivedAccess`, a capability SET — `member`/`board`/`systemAdmin`,
  not a ladder — plus `lotIds`, `contentTier`, and `hasCurrentBoardTerm`, recomputed from current
  D1 facts on every call with nothing cached) now also returns `invalidBoardGrantId` — a live Board
  grant whose qualifying term has lapsed, been cancelled, or been voided
  (`test/server/access-revalidation.test.ts`); evaluation refuses the caller `board` on the
  strength of it, independent of whether the write path already ended the grant, and recording it
  as an Access Event awaits an attribution decision on #217. `shadow-compare.ts`
  (`compareContexts`, the pure legacy-vs-derived diff shared by the request path and the offline
  sweep so neither can drift from the other) and `shadow.ts` (`compareInShadow`, wired into
  `src/middleware.ts` behind `env.CUTOVER_SHADOW === 'on'`) are mode-aware: they compute the OTHER
  model from whichever context served the request — under `legacy` it derives, as phase 2 always
  did; under `derived` it reads the legacy roster fresh via `readLegacyRosterContext` — so the two
  sides can never become a comparison of the served context with itself. It still returns `void`
  and swallows its own errors, so it remains structurally incapable of changing a response, and
  stays in place through phase 3, deleted only in phase 4 (#212). Legacy
  `getAuthContext`/`resolveAuthContext` remain the entry point for every request regardless of
  which model answers it.
- `content/`: `visibility.ts` (`tierAllows`, `visibleTiers`), `reads.ts` (per-role reads for
  announcements, documents, and now the meeting record — `fetchMeetingsFor`/`fetchMeetingFor`
  filter `status = 'approved'` UNCONDITIONALLY, including for a board caller, so a draft meeting is
  reachable only through the board-only `fetchAdminMeetings`/`fetchAdminMeeting`; a shared
  `assembleMeetingDetail` builds the attendance/motions/roll-call body for both pairs and carries no
  status or tier logic itself — see [ADR 0014](../adr/0014-meeting-record-status-gate.md).
  Its board-side name map is built from `people` (the party roster) rather than the retired
  `board_people` identity as of #248 (ADR 0022 phase 4 precondition, part 1 of 2), with every label
  routed through `personDisplayLabel` so a redacted Person renders its durable-ID fallback the same
  way every other Person read does.
  `assembleMeetingDetail` also assembles the member side — `MeetingDetail.memberAttendance`,
  per-motion `MotionDetail.memberVotes`/`memberTally`, and `totalActiveWeight`, a `SUM(vote_weight)`
  aggregate over ACTIVE properties that is the member quorum denominator, computed unconditionally
  for every meeting (including board ones) so consumers must gate its use on `meetings.body`, never
  on the value itself being non-zero; see [ADR 0015](../adr/0015-weighted-member-voting.md)).
  `assembleMeetingDetail` also takes an `includeProxyIds` admin-caller flag — the second instance of
  the ADR-0017 admin-only-field pattern, recorded together in
  [ADR 0018](../adr/0018-proxies-record-via-proxy-consolidation.md): `MemberAttendanceRow.proxyId`
  and `MemberVoteRow.proxyId` carry the real proxy id only when `fetchAdminMeeting`/
  `fetchAdminMeetings` call it `true`; `fetchMeetingFor`/`fetchMeetingsFor` call it `false`, and
  `viaProxy` — always present — is derived as `proxyId !== null` rather than a stored flag. `content/`
  also has `dedupe.ts` (SHA-256 exact matching and metadata-only near-duplicate scoring),
  `proxy-guards.ts` (`proxyUseError`, the shared cross-row guard `setMemberAttendance`,
  `setMemberVotes`, and `setBallots` each call before writing a `proxyId`, plus
  `parseProvenance`/`personExistenceError` — the latter now shared by five entry-set columns
  referencing `people(party_id)` (#234): the three acting-Person provenance columns beside a proxy
  (`member_attendance.represented_by_person_id`, `member_votes.cast_by_person_id`,
  `ballots.cast_by_person_id`), plus the two NOT NULL board roll-call columns
  `board_attendance.person_id`/`board_votes.person_id` that `setAttendance`/`setVotes` check
  directly by a plain `personId` field — `PersonFieldName` widens `ProvenancePersonKey` to admit
  that fifth field name without letting `parseProvenance` itself be asked for it), `voting-state.ts`
  (the shared SQL predicate requiring both official mode and live voting to be literal JSON
  booleans `true` for database-conditioned open and cast transitions), `voting-reads.ts`
  (`fetchOpenVotingFor`, the server-only caller-specific projection of visible open occasions,
  eligible own/proxied lots, frozen weights, valid provenance options, candidates, and `hasCast`
  receipts; it never reads `ballot_choices` or returns live tallies), and `voting.ts`
  (`normalizeVoteAction`, preflight error mapping, and atomic election/motion casting whose SQL
  repeats visibility, authority, frozen eligibility, open state, feature flags, and duplicate
  exclusion at the mutation boundary). `reads.ts` also
  has the resolutions book — `fetchResolutionsFor(env, role, { includeHistoric? })` filters
  `status != 'draft'` UNCONDITIONALLY, including for a board caller, the same rule ADR 0014 sets for
  meetings, so a draft resolution is reachable only through the board-only `fetchAdminResolutions`;
  by default it returns only `in_force`, and `includeHistoric` adds `superseded` and `repealed`.
  Both share a chain-walk helper that follows `supersedesId` backwards and re-applies the caller's
  tier filter at every step, masking an out-of-tier predecessor/successor to
  `{ id: null, number: null, title: null, visible: false }` rather than omitting it, so the chain's
  true length is never hidden. See [ADR 0016](../adr/0016-resolutions-supersession-chain.md).
  For motions, `assembleMeetingDetail` attaches current active-property eligibility totals until
  first open, then frozen totals from `motion_eligibility`. `reads.ts` also has the elections record
  — `fetchElectionsFor(env, role)` filters
  `status IN ('closed', 'certified')` UNCONDITIONALLY, including for a board caller, the same rule
  ADR 0014 sets for meetings, so a draft or void election is reachable only through the board-only
  `fetchAdminElections`; both share `assembleElectionDetail`, which always computes aggregate
  turnout (`ballotsCast`, `weightCast`, `eligibleCount`, `eligibleWeight`, `eligibilityFrozen`),
  using current active properties before first open and `election_eligibility` afterward, but
  attaches the per-lot `eligibleProperties` and `ballots` lists only for the admin caller — both
  fields are `null` on every public read. It never reads or returns `ballot_choices`. See
  [ADR 0017](../adr/0017-elections-secret-by-construction.md) and
  [ADR 0020](../adr/0020-digital-ballot-box.md). `reads.ts` also has
  `fetchAdminProxies(env)`, the board-only complete-register read: it returns every `ProxyDetail`
  with its property address and grantor/holder Person names resolved (through `personNameMap`, the
  shared `personDisplayLabel` map this file also builds the meeting record's names from), the same
  full-detail-on-list shape as `fetchAdminResolutions`/`fetchAdminElections`. Homeowner proxy reads
  use `fetchUpcomingOccasionsFor` (minimal tier-filtered scheduled-event metadata regardless of
  draft status), `fetchMemberLots` (the caller's active lots and the Persons who may act for them),
  and
  `fetchMemberProxies` (lot-scoped granted/held lists with the ADR 0019 own-lot occasion exception
  and held-row tier redaction); these are not a public or complete tier-gated proxy register.
- `db/`: Drizzle `schema.ts`, `auth-schema.ts`, `client.ts` (`getDb(env)`), migrations, and
  `invariants.ts` (`INVARIANT_CHECKS`, `runInvariants(env)`, `formatInvariantRun` — see the
  invariant-gate section of [`roster-and-access.md`](./roster-and-access.md)).
- `cleanup/`: retention jobs. `verification.ts` expires completed verification state;
  `reports.ts` purges de-anonymized saved-report text after 90 days and supplies the statement that
  performs the same purge atomically with roster redactions.
- `scheduled.ts`: `runScheduledJobs(env)`, the body of the Worker's daily `0 7 * * *` cron trigger;
  it independently runs verification cleanup, saved-report cleanup, and ADR 0022 invariants — see
  **Deploy** below.
- `roster/` and `verification/`: homeowner verification support. `roster/verification.ts` is the
  ADR 0022 phase 3c derived-mode Person matcher and confirm flow, `roster/identity.ts` is the
  shared Person Link creation/ending machinery behind `/api/verify/unlink` and
  `/api/admin/person-links`, `roster/bootstrap.ts` is the first-System-Administrator bootstrap
  behind `POST /api/bootstrap/board`, and `roster/transfer-effects.ts` is the phase 3d (#220)
  transfer-time effects engine behind `/api/admin/roster-ownerships` and
  `/api/admin/roster-representations` (see [`http-endpoints.md`](./http-endpoints.md) and [`data-model.md`](./data-model.md)) — all four join the phase 3b roster writer machinery
  described below. `roster/authority.ts` is the #248 part 2 addition and the only definition of
  "this Person holds Lot Authority over this Lot" — Ownership, or Representation of an owning
  Organization, mirroring `board-consequences.ts`'s `qualifiesGuard` — exposed both as Drizzle
  readers (`fetchLotAuthority`, `fetchPersonAuthority`, `fetchLotAuthorityHistory`,
  `hasEverHeldLotAuthority`, `fetchLotAuthorityKeys`) and as the raw-SQL `lotAuthorityExists` fragment the casting
  predicates embed; a `day` of `null` asks "did this authority EVER exist", which is what lets the
  board's pickers still offer a former owner for a past occasion while every USE of that authority
  is refused. `verification/property.ts` is the unchanged-shape legacy backend (minus its
  three retired auto-enqueue paths, and now holding the `getActiveOwnersForProperty` reader that
  moved out of `roster/lookup.ts` when the member surfaces left the legacy roster — it is the only
  caller left) and `verification/rate-limit.ts` holds the shared KV throttles
  both backends call, including the phase 3c per-Person and distinct-claimed-names caps.
- `http.ts`: `readJson` and `stringField` request-body helpers for admin writes.
- `ai/`: the board-only document assistant and report generator — `search.ts` (`retrieve`,
  Cloudflare AI Search/autorag retrieval), `pii.ts` (`buildPseudonymizer`, a reversible
  roster-based PII pseudonymizer with streaming de-anonymization), `sources.ts` (`toSources` maps
  retrieved chunks back to real D1 document rows for citations; `docIdFromFolder` extracts a
  document's uuid from either R2 key shape, `documents/<uuid>/…` or `rag/<uuid>.md`), `context.ts`
  (`buildExcerptContext`, shared by the assistant and the report generator: resolves chunks to real
  documents, drops orphan/empty chunks, and builds the pseudonymized, per-document
  `[Source N]`-numbered excerpt text), `anthropic.ts` (`getAnthropic`, Anthropic client + config
  guard), `assistant.ts` (`answer`, `loadRosterEntries` — the pseudonymization dictionary source,
  unioning Person names and Contact Methods from the live party roster (`people`, `contact_methods`)
  with owner names/phones/emails from the legacy `owners` table and `properties.address`, deduped
  by `(type, value)`; unfiltered by status/interval/void/consolidation so a former owner or an
  ended contact value already used in a document stays masked, redacted rows arrive `NULL` and are
  skipped, and Organization names are deliberately excluded from tokenized name matching (their
  contact methods are still masked) — see #233 and SECURITY.md — and the shared `claudeTextStream`/
  `ClaudeStream` streaming helpers; orchestrates retrieve -> pseudonymize -> Claude generation ->
  de-anonymized streamed output), and `report.ts` (`planSubQueries`, a small Claude Haiku call that
  expands a freeform topic into 3-6 retrieval sub-queries from the pseudonymized topic and returns
  de-anonymized queries, degrading to a single query on any failure; `generateReport`, which uses a
  template's fixed sub-queries or a planned freeform topic, retrieves and pools/dedupes/caps chunks
  at 30, and streams one Claude Opus generation into a five-section governing-documents report).
