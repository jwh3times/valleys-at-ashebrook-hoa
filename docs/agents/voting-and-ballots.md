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

**There is no GET voting API.** The feature-gated SSR `/vote` page calls that read model directly.
`POST /api/vote` accepts `castBallot` and `castMotionVote` only.

`test/server/voting-guards.test.ts` pins the handler's fixed gate order (flags → Origin → media
type → session → role) and `test/server/write-freeze.test.ts` pins that the freeze sits ahead of
the Origin and media-type checks — it is a statement about the server, not the request, so no cast
can land during a backfill.

A passed preflight grants no general lot authority. `src/server/content/voting.ts` repeats the
caller's active own-lot or occasion-scoped held-proxy predicate **inside the insert**, together
with visibility, frozen eligibility, open state, both feature flags, and duplicate exclusion — so
a race with close, pause, authority change, or another cast returns `409` without a partial write.
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
