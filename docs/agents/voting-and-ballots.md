# Live voting and ballot secrecy

Live homeowner voting is **inert by default** and its secrecy boundary is enforced by tests that
fail the build. Read this before touching anything that reads, writes, or even _names_
`ballot_choices`.

Decisions: [ADR 0017](../adr/0017-elections-secret-by-construction.md) (what secrecy does and does
not mean) and [ADR 0020](../adr/0020-digital-ballot-box.md) (the digital ballot box and the frozen
electorate). Route contract: [`http-endpoints.md`](./http-endpoints.md). Table shapes:
[`data-model.md`](./data-model.md).

## The two flags

Opening or casting requires **both** `officialMode` and `liveVotingEnabled` to be literal JSON
booleans `true`, checked in the database-conditioned mutation itself
(`src/server/content/voting-state.ts` holds the shared SQL predicate). `liveVotingEnabled`
normalizes to `false` and is fail-closed.

Turning either flag off is a **global pause, not a teardown**: new opens and casts stop, but open
lifecycle state, eligibility snapshots, turnout, votes, and retained choices all remain intact,
and re-enabling resumes any occasion still open.

## The frozen electorate

An occasion freezes its electorate on **first open** and never recomputes it:

- A conducted election writes every active property and weight into `election_eligibility`.
- A member motion writes them into `motion_eligibility`.

Live casts stamp weight **only** from that snapshot, so correcting a property's weight later
cannot rewrite a past tally. A motion's snapshot is retained unchanged across close/reopen cycles.
A monotonic `voting_revision` advances on every open, close, and successful vote-set replacement,
so a stale board correction cannot overwrite an intervening live session.

Per #204, a Lot transfer changes who may act for a Lot, never whether it counts — no snapshot,
weight, turnout row, or quorum denominator is touched. See
[`roster-and-access.md`](./roster-and-access.md).

## What "secret by construction" means here

`ballot_choices` is the identity-unlinked retained ballot box. It carries only `id`,
`election_id`, `candidate_id`, and a non-negative `weight`, and is indexed only by election. It
has **no ballot, property, owner, proxy, caster, timestamp, or shared-receipt field**, and no
other explicit identity or correlation column. None may be added, and supported reads never join a
choice to a turnout row.

**This is identifier separation, not mathematical anonymity.** Because turnout and choice rows
retain the same snapshotted weight, a rare or unique weight may identify or narrow a property's
selections, while SQLite insertion order and D1 Time Travel add temporal inference risk for a
privileged operator. Say this plainly wherever it is described; do not upgrade it to a stronger
claim.

Consequences that follow from the shape, not from policy:

- **A conducted ballot is final.** The supported caller read returns only `hasCast` — the
  application exposes nothing that could display or replace a selection.
- **No tally exists while an election is open.** Candidate `votes` stay `NULL` until conducted
  close derives final totals from the retained rows.
- Member-motion votes are a _different_ thing: attributable, and board-correctable after close.
  Only conducted-election choices are application-wide undisplayable and irreplaceable.

## The three-legged enforcement suite

#206 says this suite outlives the ADR 0022 migration rather than retiring with it.

1. **`test/unit/ballot-privacy-boundary.test.ts`** — statically scans `src/` for
   `ballot_choices`/`ballotChoices` and `candidate_id`/`candidateId`. It allow-lists only the
   schema definition, the cast path, and conducted close's tally derivation; lets the two modules
   that prose-declare the rule (`transfer-effects.ts`, `audit-schema.ts`'s `review_flags` header)
   mention it in comments only; and **hard-denies the phase 3d discovery/flag/ledger/export
   machinery any reference at all**.

   A third allow-list category, `CHOICE_NAMED_NOT_QUERIED`, holds exactly
   `server/db/invariants.ts`: moving the check list into `src/` for #240 brought its
   `no_flag_references_ballot_choices` check under this scan for the first time, since it spells
   `ballot_choices` in its own check name and operator-facing meaning string — code, not prose, so
   the prose-only exemption does not fit. A separate assertion denies that file any
   `FROM`/`JOIN`/`INTO`/`UPDATE` against the table or any `candidate_id` mention, since its SQL
   only inspects `pragma_table_info('review_flags')` for column names and reads no choice row.

2. **`test/server/ballot-privacy.test.ts`** — the runtime half, proving `ballot_choices` rows are
   byte-identical before and after a transfer, and that the review-flag register exposes only the
   turnout row.

3. **`verify:invariants`' `no_flag_references_ballot_choices`** — checked live against D1.

## Reading and casting

`fetchOpenVotingFor` (`src/server/content/voting-reads.ts`) is a **server-only, caller-specific**
read model. It returns visible open conducted elections and member motions only when the caller
controls an eligible snapshotted lot directly or holds an occasion-scoped proxy, with frozen
weights, valid provenance options, candidates, and a per-lot `hasCast` receipt. It never reads
`ballot_choices` and never returns a live conducted tally.

`src/server/content/casting-authority.ts` is the shared authority seam for that read model and both
cast preflights. It resolves the Account's current Person Link, canonicalizes a
consolidated Person one hop to the survivor, and derives that Person's current Lot Authority.
Proxy holding intersects the canonical
caller's Lot Authority with the uncanonicalized historical holder Person's Lot Authority,
preserving who the proxy names while still following a consolidated caller to the survivor's Lots.
Frozen eligibility, not current Lot status, remains the authority on whether one of those Lots
counts for the already-open occasion.

**There is no GET voting API.** The feature-gated SSR `/vote` page calls that read model directly.
`POST /api/vote` accepts `castBallot` and `castMotionVote` only.

`test/server/voting-guards.test.ts` pins the handler's fixed gate order (flags → Origin → media
type → session → role) and `test/server/write-freeze.test.ts` pins that the freeze sits ahead of
the Origin and media-type checks — it is a statement about the server, not the request, so no cast
can land during a backfill.

A passed preflight grants no general lot authority. `src/server/content/voting.ts` repeats the
current Person Link and canonical own-lot or occasion-scoped held-proxy Lot Authority predicates
**inside the insert**, together with visibility, frozen eligibility, open state, both feature
flags, and duplicate exclusion — so a stale link or race with close, pause, authority change, or
another cast returns `409` without a partial write.
An election cast writes the per-lot turnout row and every independent choice row in **one checked
D1 batch**, taking both weights from `election_eligibility`.

## The homeowner surface

`/vote` renders sign-in, verification, empty, or eligible-ballot states. Each form requires an
explicit review step that names the selection and its provenance and warns that the homeowner
cannot change, recover, or recast it. The labeled modal moves and traps focus, supports
Escape/cancel with focus restoration, and disables background voting controls.

The exact-204 success state produces a receipt containing **only the occasion title and lot
address** — never a selection. `src/lib/voting.ts` creates no receipt on a failed response.

`.oxlintrc.jsonc` disables `jsx-a11y/no-noninteractive-element-interactions` for `VoteManager.tsx`
alone, because its `role="dialog"` element legitimately owns that focus trap.

## The board surface

The Elections panel separates draft/open **Active** records from closed/certified/void
**History**, exposes conducted Open/Close and count/weight turnout monitoring, and never exposes a
live conducted tally or editable conducted ballot/choice rows. A conducted election cannot reopen.

A member motion is opened from its draft member meeting and may be closed and reopened while the
meeting stays draft; the original snapshot and votes survive those cycles. When either feature
flag is off, open rows are marked **Paused globally**.

## Recount and challenge

A conducted election's aggregate **can** be recounted: close derives every candidate's tally from
`SUM(ballot_choices.weight)`, and choice rows are never deleted, so re-summing them by candidate
reproduces the stored `candidates.votes` deterministically. ADR 0017's "cannot be recounted"
paragraph analyses an increment-only tally that was never built and is marked superseded. No
recount action exists in the admin UI; a recount is a read-only aggregate query against the
election's choice rows. It never needs, and must never add, a join from choices to turnout.

An individual ballot **cannot** be adjudicated, because choices carry no link to a lot. The
challenge procedure the board decided on 2026-08-11 (#303) follows from that:

1. Recount from the retained choice rows and record the outcome in the minutes.
2. If the recount matches and the challenge concerned only the count, the result stands.
3. Otherwise — the recount differs, or the challenge concerns eligibility, a specific ballot, or
   conduct — the board votes on a motion to void (uncertifying first when certified), and that
   motion decides whether the re-run is conducted on the site or on paper.

`void` applies only to a `closed` election and `uncertify` only to a `certified` one. The Elections
panel carries a board-facing copy of this procedure, and its void and uncertify confirmations point
at it; keep the two in step.

### Missing paper ballot

A verified homeowner sees, on `/elections`, whether each lot they held **on a recorded election's
date** is recorded as having returned a paper ballot — never what it said, and never anything about
another lot. The read is `fetchPaperBallotReceipts`
(`src/server/content/ballot-receipts.ts`); ADR 0026 records why this narrows ADR 0017's
"per-lot turnout is board-only" to "board-only, except that a lot's own holders on the election
date see that lot's status".

Two things about it are deliberate and easy to break:

- **Neither `officialMode` nor `liveVotingEnabled` gates it.** Live voting gates _conducted_
  voting, which a paper election never is; official mode gates homeowner **writes** (ADR 0019),
  while this is a tier-scoped read of a record `/elections` already shows in resident mode.
  `election-pages.test.ts` carries a flags-off positive control so a later edit cannot gate it
  silently.
- **Lot Authority is read on the election's Association Day, not today.** A recorded election has
  no frozen electorate, so the day must be named explicitly. A seller still sees the lot they held
  then; a buyer sees nothing for an election before their Ownership began.

The board's correction path, which the Elections panel states as "If a homeowner reports a missing
paper ballot" — **keep the two in step**:

1. Verify against the physical ballots. If none was returned, record that in the minutes.
2. If the ballot was missed and the result is `certified`, `uncertify` first. This voids the terms
   certification created and ends the Board Access grants they qualified; access **never resumes
   automatically**.
3. `setBallots` with the missed lot added, and `setTallies` if the physical recount shows it was
   never counted. Both are legal while the election is `closed`. `setBallots` preserves row
   identity, so correcting one lot leaves every other ballot's `id` and `recorded_at` intact.
4. `certify` again, then re-grant Board Access explicitly through `/api/admin/access-grants`.

An amendment writes **no audit-ledger event**: the ledger's families are ADR 0022's roster,
identity, service, and access facts, and adding an election family would mean rebuilding the
append-only `audit_events` table to change its CHECK. Accountability comes from the minutes, as it
does for a recount.
