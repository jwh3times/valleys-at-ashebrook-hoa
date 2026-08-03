# ADR 0017: Elections Are Secret by Construction, and What That Does and Does Not Mean

**Status:** Accepted
**Date:** 2026-08-02

## Context

An election record could link each ballot to its choices, or record only aggregates. The first
shape is easier to audit later — "show me exactly what lot 42 voted" is one join — and it is
exactly how the meeting record treats a motion: `board_votes` and `member_votes` are one row per
voter per motion, attributable by design, because that is the accountability residents expect on
a vote to spend association money or amend a governing rule. Applying that same shape to a board
election trivially destroys the secret ballot: any table that can answer "how did lot 42 vote" is
a table that already answers it, whether or not any code path currently queries it that way. The
paper ballot this feature is recording was cast anonymously; a digital record less anonymous than
its own source of truth is a regression, not a modernization.

## Decision

`ballots` records only that a lot returned a ballot for an election — `election_id`, `property_id`,
a weight snapshot, and cast-by/proxy provenance. No `ballot_id -> candidate_id` table exists, and
none may be added. Turnout (how many lots voted, how much vote weight that represents) is
answerable from this table; which candidate any lot chose is not recorded anywhere, by anyone, at
any tier. `candidates.votes` holds only the board-entered aggregate tally per candidate — a number
typed in from the paper count, not derived from any per-ballot row — and is nullable so "not yet
tallied" is distinguishable from "tallied at zero."

Motions take the opposite treatment deliberately. A vote on an assessment, a rule change, or
spending is attributable per property in `member_votes`, because that is the accountability
residents expect on the board's exercise of authority between elections. An election, by contrast,
is residents choosing who exercises that authority, and the ballot secrecy norm for that choice
predates this software and is not this software's to weaken. The asymmetry between the two tables
is the design, not an inconsistency to reconcile.

Winners and tallies are board-entered, following the same pattern `motions.outcome` already
established: passage thresholds and tie-break rules vary by bylaws and are not this system's to
adjudicate, so `certified` winners and per-candidate `votes` are typed in by the board from the
paper count, never derived. `elections.source` (`recorded` vs. the PR 6 `conducted` mode) is
create-immutable, because every guard this feature relies on — that a `recorded` election's tally
can only ever be typed in, never incremented — tests `source` to decide which write path is legal.
If `source` itself were patchable after creation, flipping it would not be a bypass of one guard;
it would be a bypass of all of them at once, turning "the board can never type a tally for a
conducted election" into "the board can type any tally it wants, retroactively."

## Consequences

For a `recorded` election — the only kind this feature (PR 5) builds — the secrecy guarantee is
absolute: the link between a ballot and a candidate never exists in this system, digitally or
otherwise, because it was never entered. The association's paper ballots remain the primary record
of who voted for whom, exactly as they were before this feature existed. This software adds a
durable, tier-gated public record of turnout and results; it does not, and structurally cannot,
add a way to reconstruct an individual's choice, because that fact was never captured in the first
place. There is no query, no admin export, no future migration that can recover what was never
written down.

**That guarantee does not extend to PR 6's conducted mode**, and this ADR exists chiefly to say so
before that mode is built, not after. A conducted election lets residents cast ballots through the
system itself rather than on paper, with `candidates.votes` incrementing live as ballots arrive.
Once tallies are live and derived from real per-ballot events rather than typed in after the fact,
ballot secrecy stops being a property of what tables exist and becomes a property of what an
observer can infer from them — a much harder guarantee to make, and one this design does not yet
make. Four distinct failure modes apply to a conducted election, none of which a `recorded`
election is exposed to:

- **Arithmetic disclosure.** A unanimous result, a candidate sitting at zero votes with one ballot
  outstanding, or a race with only one or two ballots cast at all, lets anyone who can see the
  tally and the turnout count derive individual choices by elimination — no database access
  required, just the two numbers this same ADR requires the public page to publish.
- **Live tally diffing.** If per-candidate counts are visible while voting is still open, watching
  a count change between two page loads — by whoever loaded the page, or by an operator watching
  the underlying table — links a specific instant to a specific ballot, and a caller who also knows
  who was voting around that instant learns their choice.
- **The timestamp join.** `candidates` deliberately has no `updated_at` (see the schema comment on
  that table) precisely because a conducted mode that touched one on every increment would let
  anyone with row-level access pair the newest `candidates.updated_at` against the newest
  `ballots.recorded_at` and read off the last ballot's choice. Adding that column back in PR 6
  "for consistency with every other table" would silently reopen this hole; the omission is load-
  bearing, not an oversight.
- **D1 Time Travel.** Cloudflare's point-in-time recovery lets an operator replay a D1 database's
  write history and diff consecutive states. For a `recorded` election this recovers nothing new —
  the tally was written once, as a finished fact, with no history to replay. For a conducted
  election it recovers exactly the increment-by-increment history that live tallying produces,
  and no application-level design can prevent it: it is a platform capability operating below
  anything this codebase controls.

A conducted election also **cannot be recounted**. An increment-only tally is a running sum with no
ballot-level record behind it to re-examine; the only thing it can ever answer is "trust the
increments as they were applied." A `recorded` election can be recounted the same way its paper
original can — the board re-reads the paper and re-enters a corrected tally — but a conducted
election's tally, once wrong, has no underlying evidence to reconcile it against. Retention regimes
that govern HOA elections, including California's Davis-Stirling Act (Civ. Code §5125), are written
assuming the association retains physical ballots in a form that supports exactly that kind of
recount; an increment-only tally cannot provide that custody, no matter how the increments are
logged. **This is a decision to make deliberately before PR 6 is designed, not a detail to settle
while building it**: either a conducted election acquires some verifiable-but-still-secret ballot
record sufficient to satisfy those retention rules, or conducted mode is scoped to elections where
that requirement does not bind, or it is not built as originally imagined at all.

Finally, this ADR corrects a claim in the earlier planning spec for PR 6: that cumulative voting —
letting a voter split their ballot's weight across candidates — is blocked by the absence of a
ballot-to-candidate link. It is not. Cumulative voting needs only an increment-by-allocation write
per candidate at cast time (`candidates.votes += allocated_amount`, once per candidate per ballot);
it needs no row that persists which ballot made which allocation, so it is no more exposed by this
schema than single-choice conducted voting is. The real blocker to cumulative voting is validation
— confirming a ballot's allocations sum to no more than its weight before any of them are applied —
and recount, which cumulative voting makes strictly harder than the single-choice case this ADR
already flags as unresolved above.
