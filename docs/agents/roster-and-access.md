# Roster and derived access

The ADR 0022 party roster is what authorization runs on. This file covers the model, its current
state, the invariants that hold it together, and the work that remains.

- The decision and its rationale: [ADR 0022](../adr/0022-party-roster-derived-access.md).
- The vocabulary (Lot, Person, Ownership, Representation, Lot Authority, Access Grant):
  [`CONTEXT.md`](../../CONTEXT.md).
- The modules: [`module-map.md`](./module-map.md). The routes:
  [`http-endpoints.md`](./http-endpoints.md). The tables: [`data-model.md`](./data-model.md).

## Current state

The code implements ADR 0022 phase 4 (#212). Migration `0037` and this version of the
Worker form one contract: `properties` becomes `lots`, `board_service_terms` becomes
`board_terms`, and the legacy roster, verification, link, and shadow tables are removed.
The old `board_terms` is dropped before the permanent term table takes its name.
`users.role` remains structurally required by Better Auth, but is neutralized to `visitor`;
site code neither derives authority from it nor maintains role/link mirrors.

The production rollout requires the coordinated migration/deploy procedure in
[`migrations.md`](./migrations.md); code completion does not imply it has run.
The one-time import/backfill commands are retired. Ongoing roster maintenance uses the
Roster, Board, and Access panels. Legacy-note preservation is an operator prerequisite.
The write freeze, permission matrix, invariant checks, and ballot-privacy suites remain.

## The seam

`getAuthContext(request, env, associationDay)` in `src/server/authz/context.ts` resolves
an authenticated account through `deriveAccess` on every request. There is no mode switch
or stored-role fallback. Missing links or authority confer no capabilities, and ending a
link or grant affects the next request. The API regression suite
`test/server/derived-only-access.test.ts` covers this boundary.

**Capabilities are a set, not a ladder.** `AuthContext.capabilities` holds
`member`/`board`/`systemAdmin`: `systemAdmin` implies `board`, but neither implies `member`, which
comes only from Lot Authority. The live consequence of derived authorization is exactly this — a
board member who owns no Lot is refused the member surfaces while still admitted to board ones.
Content reads take the caller's `contentTier`; access questions take `capabilities`. The phase-3
aliases for those (`role`, `propertyIds`) are deleted (#212).

## The write freeze

`src/server/authz/write-freeze.ts` is the operator-only maintenance switch built for the phase-3
flip and retained after phase 4. It reads the uncached `cutover_settings.write_freeze` singleton,
**fail-closed**: a read error or an active freeze answers `503`, while an absent row is the normal
un-frozen state rather than an error.

Coverage is **deny-by-default and path-derived**. `freezePolicyFor(path)` first normalizes the
path through `routedPathname` (`src/server/authz/request-path.ts`) — Astro decodes a pathname
repeatedly, up to 10 times, before matching a route, so an encoded namespace like
`/api/%6dember/proxies` would otherwise classify as `mutations` while still routing to the frozen
`everything`-class handler — then is the single authority both enforcement layers consult:

| Policy       | Paths                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `everything` | `/api/member/*` and `/api/vote` — no read-only half worth keeping live |
| `exempt`     | `/api/auth/*` and `/api/bootstrap/board` — exactly two                 |
| `mutations`  | **everything else**, including paths nobody has written yet            |

The two exemptions each have a reason: sign-in writes a session row, and an operator locked out of
`/admin` cannot run the flip; and flip step 4 creates the first System Administrator while the
freeze is on.

`writeFreezeError(env, request)` takes no scope argument — it derives coverage from the request's
own path, so no call site can hold a stale opinion about what its surface freezes, and middleware
and the per-route guards cannot drift. It is called from `requireBoard`, `requireMemberApi`,
`requireVotingApi`, both `/api/verify/*` routes, and `src/middleware.ts` — whose final `else`
branch catches any surface no named branch claims.

Three suites hold it: `test/unit/freeze-coverage.test.ts` enumerates every route module and fails
if a mutating route ends up live without being declared in both that test and `ALWAYS_LIVE`;
`test/server/write-freeze.test.ts` pins the freeze's position in each guard order; and
`test/unit/adr0022-model-boundary.test.ts` pins that `write-freeze.ts` references no ADR 0022
table other than the `cutover_settings.write_freeze` singleton.

**This inverts the auth-gate enumeration, deliberately.** The auth gates name the surfaces they
protect, which is why `admin-routes-all-gated.test.ts` has to exist — their coverage is a function
of what somebody remembered to list. The freeze runs the other way: a route added tomorrow is
covered before anyone thinks about it. When adding a route you must remember its auth guard; you
do not have to remember the freeze.

## Lot Authority

`src/server/roster/authority.ts` is the **only** definition of "this Person holds Lot Authority
over this Lot" — Ownership, or Representation of an owning Organization — mirroring
`board-consequences.ts`'s `qualifiesGuard`, so Lot Authority means the same thing to a board term,
a proxy, and a cast.

It carries the rule **twice on purpose**, for ADR 0020's two layers: a Drizzle reader
(`fetchLotAuthority`, `fetchPersonAuthority`, `fetchLotAuthorityHistory`,
`hasEverHeldLotAuthority`, `fetchLotAuthorityKeys`) for preflights and pickers, and the raw-SQL
`lotAuthorityExists` fragment that mutation-boundary predicates embed to re-check inside the
INSERT. `test/server/lot-authority.test.ts` runs both over the same fixtures and fails on a
divergence, which is the failure this arrangement is otherwise exposed to.

A `day` of `null` asks "did this authority EVER exist" — the weaker question. That is what lets
the board's pickers still offer a former owner for a past occasion while every _use_ of that
authority is refused.

`src/server/content/ballot-receipts.ts`'s `fetchPaperBallotReceipts` (#302, ADR 0026) is a second
direct consumer of derived access, but not of the readers above: it embeds `derive.ts`'s `LOT_SQL`
itself as a subquery, bound to the caller's account and to each recorded election's own Association
Day, so a lot's own holders on that day — and no one else — see whether their lot's paper ballot is
recorded. See [`voting-and-ballots.md`](./voting-and-ballots.md).

`lotAuthorityExists` has a period-bounded sibling, `lotAuthorityCoversRecordDay` — same builder,
additionally requiring the record's own date to fall on or after the start of the authority that
grants it, so a buyer who holds Lot Authority today reads nothing the seller's period produced. It
backs Lot Records (#291, ADR 0024 — board data entry shipped in slice 2, its own admin screen in
slice 3, and the homeowner-facing `/lot-records` page in slice 4, completing the feature; see
[`data-model.md`](./data-model.md) and `src/server/lot-records/` in
[`module-map.md`](./module-map.md)), which are a **second scoping axis alongside the content
tier**: a Lot Record's audience is decided by its `lot_id` joined against the roster, not by
`visibility`, and it is gated separately — a Lot Record surface requires both `officialMode` and
the default-off `lotRecordsEnabled` site gate. A Lot Record table carries no `visibility` column at
all — putting the two axes on one column would let a future tier edit publish one Lot's record to
every member — so content-tier visibility and Lot Authority scoping never interact for these
tables.

**Consolidation canonicalization is asymmetric on purpose.** `derive.ts`'s `LOT_SQL` resolves the
caller's Person one hop through `COALESCE(consolidated_into_party_id, id)` before computing
`lotIds`, because consolidation only MARKS a duplicate Party — it moves no Ownership or
Representation row — so an account linked to a duplicate would otherwise be told (via `lotIds`)
that it holds the survivor's Lots while every per-Person read still keyed on the duplicate's own
id. `src/server/lot-records/reads.ts`'s homeowner reads (`fetchMemberLotViolations`,
`fetchMemberLotViolation`, `fetchMemberLotAddresses`, and — since ADR 0025's ledger — `fetchMemberDuesLedger`)
repeat that same one-hop canonicalization in an internal `me` CTE before scoping, because without it
a duplicate-linked account would be shown none of the records for the Lots `lotIds` just told it it
holds — an empty page indistinguishable from a Lot with nothing recorded, the worst answer that
surface can give. `roster/authority.ts`
deliberately does **not** canonicalize: there the question is "who acted" (a proxy grantor, a
ballot caster, a Board Term holder), and the Party named on that historical record is the answer,
duplicate or not. Canonicalize only when the question is "which Person is this **account**" —
`LOT_SQL` and the Lot Records homeowner reads both ask that; `roster/authority.ts` never does.

## Writing to the roster

Every mutation on the phase 3b/3c/3d roster routes is **ONE D1 batch of conditional statements**:
domain writes first, then the immutable-ledger rows built by `src/server/roster/audit.ts`'s
`AuditCorrelation`. The rules:

- **One command = one correlation.** Root event `seq 0` with a unique `operation_key`;
  consequences name the root as cause.
- **Every statement is gated** so a lost race leaves ZERO rows anywhere, with `meta.changes` on
  the primary deciding the `409`.
- `assertInBatch` is a statement that ERRORS to roll a whole batch back when an all-or-nothing
  part failed.
- **One documented ordering exception:** `review_flags` INSERTs FK-reference the
  `review_flag_opened` audit event that opens them, so `effects.flagStatements` runs _after_
  `correlation.statements` in every caller's batch.

`board-consequences.ts` holds `qualifiesGuard`, `noOverlapGuard`, and `lossConsequences` — the
substitute-or-terminate engine that ends or cancels Board Terms, their offices, and their grants
when an Ownership or Representation change removes a qualifying basis. The term ends on the
real-world day; the grant always at recorded-at.

Interval non-overlap (per Person **and** per qualifying Lot) is conditional SQL at the mutation
boundary, not an application check.

**Access Grants are never implicit.** They are created only through `/api/admin/access-grants`'s
explicit `grant` action or `/api/admin/roles`'s `promote` under `derived` — both calling the same
`grantStatements` builder in `src/server/roster/access.ts`. Certification creates none. The
last-System-Administrator invariant lives on exactly that one route as a mutation-boundary guard,
never in evaluation, and a refused attempt is permanently recorded as a denied Access Event.

**Only a System Administrator may end another account's System Administration**, on every path
that can end one. `/api/admin/access-grants` `revoke` has always asked this; the path that ends
grants as a _consequence_ of ending a Person Link — `/api/admin/person-links` `unlink` (the now-
deleted `/api/admin/members` `revoke` carried the same fix before #212 removed the surface) — did
not, so any Board Access holder could demote a System Administrator by unlinking them. It now
refuses with `403` when the target holds a live `system_admin` grant and the caller is not one,
passing `refuseIfTargetIsSystemAdministrator` to `endLinkStatements`, which repeats the condition inside
the link-ending `UPDATE`'s `WHERE` so a grant created between the preflight and the batch loses
the whole command (`409`) rather than being ended by a caller who may not touch it. Board Access
is unaffected: a Board Access holder may still unlink an account holding only Board grants, their
own included.

This refusal comes **before** the last-System-Administrator invariant, so a Board Access caller
aiming at the sole administrator now gets `403` (want of authority) rather than `409` (the
invariant). Only an administrator reaches the `409`. Like the Access Grants route's own capability
check, and unlike the invariant, the `403` is not recorded as a denied Access Event.

**Grants are re-validated on every evaluation, not trusted.** `derive.ts` returns
`invalidBoardGrantId` for a live Board grant whose qualifying term has lapsed, been cancelled, or
been voided (`test/server/access-revalidation.test.ts`); evaluation refuses the caller `board` on
the strength of it, independent of whether the write path already ended the grant.
`src/server/authz/revalidation-event.ts` records that as an account-attributed root Access Event,
day-idempotent by `operation_key = grant-revalidation:<grant>:<day>`, written only when `derived`
is the **serving** model, with errors swallowed so evaluation cannot 500 on a ledger failure.

Board sign-in access has its own admin panel — **Board access** (`BoardAccessManager`) —
distinct from the **Board** panel (`BoardServicePanel`) that records who serves. Neither sense
ever writes the other's data.

## Transfer effects

`src/server/roster/transfer-effects.ts` runs at the mutation boundary of
`/api/admin/roster-ownerships` (`end`, `void`) and `/api/admin/roster-representations`
(`end`, `void`, `correctScope`).

Per #204, a transfer changes **who may act** for a Lot, never **whether the Lot counts**: no
eligibility snapshot, weight, turnout row, or quorum denominator is touched.

The **one** stored action it reverses is an open member-motion vote for the transferred Lot —
`member_votes` deleted and the motion's `voting_revision` advanced under the same compare-and-swap
`setMemberVotes` and live casting already require. Closed motions are untouched, and a
Representation change never resets a vote.

Everything else is **surfaced, never rewritten**, as a `review_flags` row. Retrospective discovery
walks the `[effectiveDay, recordedAt]` window (occasion-day rule for member attendance/votes,
recorded-instant rule for ballots and granted proxies); a forward pass over still-upcoming
occasions flags pending held proxies and not-yet-concluded conducted ballots. One flag per record:
the forward pass is enumerated first and wins any record both passes would reach. A void
supersedes its own open flags rather than deleting them.

**Ballot secrecy:** this module never reads, joins, names, or counts `ballot_choices` or a
candidate selection. See [`voting-and-ballots.md`](./voting-and-ballots.md).

## The invariant gate

17 queries in `src/server/db/invariants.ts` (`INVARIANT_CHECKS`) — interval non-overlap on
Ownerships/Representations/Board Terms/Office Assignments, party-subtype completeness, audit-event
detail cardinality and causal order, redaction/review-flag completeness, a check that no
`review_flags` column references ballot choices or candidates, and two view-backed checks.

**Two callers, one shared source.** Per #240 (decided by #206 — "the checks that gate a migration
are exactly the checks that catch drift afterwards") they must never disagree about the set. A
Worker cannot spawn a subprocess, so they cannot share an execution path and share the _queries_
instead:

- `npm run verify:invariants` (`scripts/verify-invariants.ts`) owns the Wrangler-subprocess
  machinery and `--local`/`--remote` — that path is why the CLI, not the cron job, can point at
  remote D1 from a laptop. Exits non-zero on a violation.
- `src/server/scheduled.ts`'s daily `0 7 * * *` cron job runs `runInvariants(env)` straight
  through the `DATABASE` binding. Throws on a violation.

`runInvariants` executes every check sequentially (a daily background job has no latency budget,
and `PRAGMA foreign_key_check` walks every table) and **never throws for a violation** — the
caller decides. `CheckResult.status` is `ok`/`violated`/`errored`/`pending`, with **`errored`
deliberately distinct from `ok`** because a failed query also returns zero rows, and zero rows is
this gate's green. Nothing about a violation is stored, since a real one re-fires every day until
fixed.

Two constraints worth knowing before adding a check:

- `audit_integrity_violations_v` sits exactly at **D1's five-term compound-`SELECT` ceiling**. A
  sixth check there needs a second view, not a sixth branch.
- The CLI's query execution retries up to 3 attempts, absorbing an intermittent Node 26/Windows
  Wrangler libuv exit-crash _after_ the query already succeeded. A deterministic failure — stdout
  carrying Wrangler's own `--json` error object — fails immediately instead of burning retries,
  and a response shaped as anything other than exactly one statement result throws rather than
  being read as zero rows.

`test/server/invariants.test.ts` runs all 17 through the real `DATABASE` binding;
`test/unit/invariants-single-source.test.ts` is the anti-drift guard, asserting neither caller
contains a `SELECT`/`PRAGMA` of its own.

## Contract safeguards

`test/unit/legacy-roster-consumers.test.ts` scans imported Drizzle symbols and raw SQL
for references to removed tables; its consumer list must stay empty. Historical migrations
retain their original names and statements. The migration test checks populated ownership
and board history, surviving foreign keys, neutral roles, and the retained write freeze.

Migrations `0028` and `0029` already repointed historical Person references away from the
dropped tables. Migration `0037` uses SQLite renames, which update surviving foreign keys
and stored view definitions without rebuilding their data. The 17 shared invariants and
`PRAGMA foreign_key_check` remain required after application.
