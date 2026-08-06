# ADR 0020: Digital Ballots Are Retained Without an Explicit Turnout-to-Choice Link

**Status:** Accepted
**Date:** 2026-08-06

## Context

ADR 0017 made recorded paper elections secret by construction by storing turnout separately from
board-entered aggregate tallies. A site-conducted election needs more than an increment-only tally:
the association must retain enough ballot evidence to reproduce the result, while the database
must still be unable to answer how a named owner, proxy, or property voted.

The live-voting feature is being delivered in independently safe slices. Slice 1 supplies only the
default-off setting, additive schema, frozen-electorate read model, and board-only lifecycle
operations. It does not ship `/vote`, `/api/vote`, ballot casting, or homeowner voting UI.

## Decision

### Separate turnout from identity-unlinked retained choices

`ballots` remains the turnout register. It records that a property participated, its snapshotted
weight, and owner-or-proxy provenance, but no candidate selection. `ballot_choices` is the retained
digital ballot box and contains only `id`, `election_id`, `candidate_id`, and non-negative `weight`.
It has no ballot, property, owner, proxy, caster, timestamp, or other explicit identity/join field.
Supported application reads never join choice rows to turnout rows.

There must never be a ballot-choice column whose role is to directly or indirectly identify a
turnout row. In particular, do not add `ballot_id`, `property_id`, owner/proxy/caster provenance, a
cast timestamp, a shared receipt, or a new explicit join key. Application types, APIs, logs, and
exports must not add an identity mapping around the schema boundary. A future need to change this
rule requires a new ADR that explicitly replaces this one; it is not an ordinary schema extension.

A submitted election ballot is final. Because the supported application has no identifier or join
key that resolves its choices back to one turnout row, neither the homeowner nor the board can
retrieve and edit that ballot through the application. A material casting error requires voiding
and rerunning the election. This application-level separation is not a promise of mathematical
anonymity; the retained values still permit the inferences described below.

### Freeze the electorate at the record date

`election_eligibility` and `motion_eligibility` snapshot every active property's id and vote weight
when the election or motion first opens. Those rows are the vote's record-date electorate. Later
roster, property-status, or weight changes do not alter who was eligible or the denominator for
that vote. Election configuration and candidate identity become immutable after opening. A
motion's text becomes immutable after its first open, and a close/reopen cycle reuses the original
motion snapshot rather than taking a new one.

Before a snapshot exists, administrative reads use the current active-property roster as a
clearly marked fallback. After first open, reads report frozen eligibility totals; the board-only
election read may also inspect the eligible-property rows. Public election reads never receive
that per-property eligibility list.

### Derive final election results only at close

Conducted elections move `draft -> open -> closed`, with the existing certification and void paths
continuing from the appropriate states. Opening and snapshot creation occur in one D1 batch and
require both `officialMode` and the default-false `liveVotingEnabled` setting, a visible conducted
draft, at least one non-withdrawn candidate, and at least one active property.

While a conducted election is open, `candidates.votes` remains `NULL` and no live candidate tally
is populated or exposed. Closing is one-way and atomically changes the election to `closed` and
derives every candidate's final tally from `SUM(ballot_choices.weight)`; a candidate with no choice
rows receives a real zero. The retained choice rows therefore support deterministic recounting of
the aggregate result without storing an explicit identifier for which lot selected which
candidate.

Recorded elections keep their existing paper-record workflow. Board-entered `setTallies` and
`setBallots` remain restricted to `source: 'recorded'` and cannot mutate conducted results.

### Retain live-voting history and serialize motion corrections

A motion's first open creates its eligibility snapshot. Closing may be reversed while its parent
member meeting remains a draft, but the frozen snapshot and any genuine live votes are retained.
A motion or parent meeting with live-voting history cannot be deleted.

Board corrections through `setMemberVotes` are allowed only while voting is not open. Each motion
has a monotonic `voting_revision`; open, close, and every successful full vote-set replacement
advance it. The replacement is a D1-batch compare-and-swap on both state and revision, so a stale
correction cannot overwrite an intervening open/close session even if the visible state has
returned to `closed`.

## Consequences

- The database retains recountable digital election choices and final weighted results without an
  explicit relational identifier or join key from turnout provenance to candidate choice.
- The board can audit who was eligible and whether a property participated. Supported application
  reads do not reveal how that property voted, but retained values may permit inference; this is
  weaker than mathematical anonymity. Homeowner-facing voting and casting remain unavailable until
  later slices add their routes, authorization boundary, and UI.
- No live tally exists for a conducted election. Closing is the first operation that derives and
  stores candidate totals, reducing timing and elimination disclosure while voting is in progress.
- Frozen election and motion eligibility makes quorum and turnout denominators historically stable
  and prevents later roster changes from rewriting the record date.
- Identity-unlinked final ballots cannot be changed or individually adjudicated through the
  supported application. Operational mistakes are handled by voiding and rerunning the election,
  not by weakening the separation.
- Retained weight is itself an inference surface: because `ballots.weight` and
  `ballot_choices.weight` carry the same snapshotted voting weight, a rare or unique weight can
  identify or narrow which property selected a candidate. Even when every production weight is
  currently 1, ADR 0015 permits weighted associations, so this risk is part of the durable model.
- D1 also has residual operator-level temporal correlation risk. A sufficiently privileged
  operator may infer proximity from SQLite row insertion order or use D1 Time Travel to compare
  successive database states. Omitting explicit choice identifiers, join keys, and timestamps
  narrows these risks but does not guarantee anonymity or eliminate inference below the supported
  application layer. Operational access and retention controls remain part of the secrecy
  boundary.

## Related decisions

- [ADR 0015: Vote Weight Is Always Present and Always Summed](./0015-weighted-member-voting.md)
- [ADR 0017: Elections Are Secret by Construction, and What That Does and Does Not Mean](./0017-elections-secret-by-construction.md)
- [ADR 0018: Proxies Are Their Own Table, Not a Boolean on Every Vote](./0018-proxies-record-via-proxy-consolidation.md)
- [ADR 0019: Homeowner Writes Are Official-Mode Gated](./0019-homeowner-writes-official-mode-gate.md)
