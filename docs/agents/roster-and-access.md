# Roster and derived access

The ADR 0022 party roster is what authorization runs on. This file covers the model, its current
state, the invariants that hold it together, and the work that remains.

- The decision and its rationale: [ADR 0022](../adr/0022-party-roster-derived-access.md).
- The vocabulary (Lot, Person, Ownership, Representation, Lot Authority, Access Grant):
  [`CONTEXT.md`](../../CONTEXT.md).
- The modules: [`module-map.md`](./module-map.md). The routes:
  [`http-endpoints.md`](./http-endpoints.md). The tables: [`data-model.md`](./data-model.md).

## Current state

**Production runs `cutover_mode = derived`.** The flip was executed 2026-08-18 UTC under a
27-minute operator write freeze (#222, closed). Derived authorization answers every request:
capabilities and content tier are recomputed per request from the party roster — Person Link,
Ownerships and Representations, Board Terms, and Access Grants — with nothing cached.

`users.role` and `user_property_links` survive only as **write-behind mirrors**, kept so the
legacy read model and Better Auth sessions stay coherent. Neither is read for authorization
anywhere outside `context.ts`'s `legacy` branch, which `test/unit/authz-legacy-role.test.ts` pins
by import-scanning the rest of `authz/`.

`POST /api/bootstrap/board` is permanently self-disabled: its `system_admin_bootstrap` singleton
is consumed and a re-run answers `410`.

**Only phase 4 (#212) remains** — deleting the shadow layer (`shadow.ts`, `shadow-compare.ts`, the
offline sweep) and the `role`/`propertyIds` compatibility aliases, and renaming `properties` to
`lots`. The write freeze, the permission matrix, and the ballot-privacy suites are retained
permanently per #206/#212, not retired with the migration.

## The seam

`getAuthContext(request, env, associationDay)` in `src/server/authz/context.ts` is the single seam
every guard, page, and route resolves its caller through. It reads the uncached
`cutover_settings.cutover_mode` singleton and branches:

- **`derived`** — `derivedContext(deriveAccess(...))`, recomputed from current D1 facts.
- **`legacy`** — `legacyAuthContext`, which synthesizes a context from stored
  `users.role`/`user_property_links` and deliberately reproduces the old rank ladder (a board
  caller gets `member` too), so writing the flag back is bit-for-bit what the site was.

`getCutoverMode` **fails closed to `legacy`** — the opposite polarity from the write freeze,
deliberately. The freeze falls back to _frozen_ because refusing is the restrictive answer; the
safe answer here is whichever model is already serving production. Since the flip the row exists
and reads `derived`, so an absent row now means the singleton was never written.

`test/server/adr0022-parity.test.ts` runs every caller class through `getAuthContext` with
`cutover_mode` in both positions — including a board caller who owns no Lot, and a revocation that
must take effect on the very next request.

**Capabilities are a set, not a ladder.** `AuthContext.capabilities` holds
`member`/`board`/`systemAdmin`: `systemAdmin` implies `board`, but neither implies `member`, which
comes only from Lot Authority. The live consequence of derived authorization is exactly this — a
board member who owns no Lot is refused the member surfaces while still admitted to board ones.
The `role` (= `contentTier`) and `propertyIds` (= `lotIds`) aliases feed nothing but content
reads and are deleted in phase 4.

## The write freeze

`src/server/authz/write-freeze.ts` is the operator-only maintenance switch built for the phase-3
flip and retained after phase 4. It reads the uncached `cutover_settings.write_freeze` singleton,
**fail-closed**: a read error or an active freeze answers `503`, while an absent row is the normal
un-frozen state rather than an error.

Coverage is **deny-by-default and path-derived**. `freezePolicyFor(path)` is the single authority
both enforcement layers consult:

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

**Grants are re-validated on every evaluation, not trusted.** `derive.ts` returns
`invalidBoardGrantId` for a live Board grant whose qualifying term has lapsed, been cancelled, or
been voided (`test/server/access-revalidation.test.ts`); evaluation refuses the caller `board` on
the strength of it, independent of whether the write path already ended the grant.
`src/server/authz/revalidation-event.ts` records that as an account-attributed root Access Event,
day-idempotent by `operation_key = grant-revalidation:<grant>:<day>`, written only when `derived`
is the **serving** model and never from shadow, with errors swallowed so evaluation cannot 500 on
a ledger failure.

Board sign-in access has its own admin panel — **Board access (legacy)** (`BoardAccessManager`) —
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

## Phase 4's remaining preconditions

**`test/unit/legacy-roster-consumers.test.ts`** declares every `src/` module reading one of the
six tables phase 4 drops (`owners`, `user_property_links`, `property_verifications`,
`manual_approval_queue`, `board_people`, and the legacy `board_terms`), together with what phase 4
must do about it.

It exists because of **#233**: the AI pseudonymizer kept reading `owners` after the flip made the
party roster authoritative, and nothing detected it — the flip's checklist verified that
_authorization_ stopped reading the legacy model and never enumerated the non-authorization
consumers. The scan checks both imported Drizzle symbols **and** raw SQL, because an import-only
scan would miss `server/roster/verification.ts`, whose `user_property_links` write-behind mirror
is a raw `INSERT` with no Drizzle symbol imported. A declared entry whose module no longer reads a
dropped table fails the suite as stale, so the list cannot rot into a misleading audit.

Each declared module carries one of five dispositions:

| Disposition                    | Meaning                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `deleted-with-the-table`       | Five legacy surfaces #212 deletes outright, including `context.ts`'s `legacy` branch. |
| `write-behind-mirror`          | Two modules whose write nothing reads for behavior.                                   |
| `already-dual-read`            | `server/ai/assistant.ts`, the #233 fix — phase 4 drops only its legacy arm.           |
| `needs-repointing`             | `content/voting.ts` and `content/casting-authority.ts`.                               |
| `blocked-on-person-repointing` | Now **empty**, kept as a heading.                                                     |

The `needs-repointing` pair is the same question twice: an **account's** claim on a lot, read from
`user_property_links`. That is not a roster question at all, which is why the roster work did not
close it — the roster says who may act for a lot, `user_property_links` says which lots this
_login_ was verified for, and phase 4 answers that from `person_links`.

**#248 closed the FK precondition.** Migrations `0028` and `0029` repointed every FK column off
`board_people` and `owners` onto `people(party_id)`, so **no table phase 4 keeps references either
legacy table any more**, unblocking #212's steps 3 and 4. Four of the five `owners` columns were
`ON DELETE SET NULL` — the dangerous half, where dropping the parent would have _succeeded_ and
silently erased who acted from historical records rather than failing loudly. All five measured 0
non-null values in production on 2026-08-20, so it was a pure schema change; the migrations'
mapping branches exist for a database where that is not true. See
[`migrations.md`](./migrations.md).

## The backfill, post-flip

`scripts/migrate-roster.ts` (`npm run roster:backfill`, planning in `scripts/backfill-plan.ts`) is
dry-run by default. `--write --operator=<accountId>` applies it, writing exception queues for
ambiguous cases and an audit baseline (one correlation per migrated root entity,
`actor_kind = 'migration'`). The repeatable `--classify=<accountId>=technical` flag resolves an
account's `board_account_unclassified` blocking exception on the record and plans no rows, since
System Administration Access arrives only via `POST /api/bootstrap/board`; an unmatched account id
is itself a new blocking exception (`classification_unmatched`), and any other classification
value exits 2.

`src/server/roster/normalize.ts` (`normalizeEmail`, `normalizePhone`, `normalizeName`) is what
lets the backfill detect cross-Party contact ambiguity that legacy data never normalized
consistently enough to catch on its own. A legacy identity that cannot be mapped to a
`people.party_id` — the backfill's `derivedId` mapping is a JS digest SQL cannot compute — is
dropped rather than invented; see [`migrations.md`](./migrations.md).

> **Caution.** The default (non-`--authoritative`) `--write` mode is a **clean replace**. It was
> safe only while the new model was inert. The flip's authoritative backfill has since seeded the
> roster production runs on, so `--write` against remote D1 without `--authoritative` would delete
> live roster rows and their audit baseline. **Any future run against production must pass
> `--authoritative`** — the insert-once mode (`ON CONFLICT DO NOTHING`) that deletes nothing and
> refuses to run while a flip-blocking exception is outstanding.

`scripts/shadow-sweep.ts` derives both contexts for every account offline, sharing `derive.ts`'s
SQL and `shadow-compare.ts`'s comparison with the request-path shadow rather than reimplementing
them. Local execution batches through Wrangler's `--file`; **remote execution goes through
order-preserving `--command` chunks instead**, because remote `--file` is D1's import API
(progress lines plus one summary, no per-statement results) and would otherwise silently
mis-index as data. `scripts/wrangler-d1.ts` holds the shared helpers — `parseD1Output`,
`chunkStatements`, `withRetry`.
