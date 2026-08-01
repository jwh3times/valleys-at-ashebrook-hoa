# ADR 0015: Vote Weight Is Always Present and Always Summed

**Status:** Accepted
**Date:** 2026-08-01

## Context

Member meetings vote per property, not per person, and homeowners associations sometimes weight a
property's vote by lot size or ownership share rather than counting it as one vote per lot. The
obvious design is a weighted mode: an association-level flag that switches tallying, quorum, and
results between counting rows and summing a weight column, so associations that vote one-lot-one-
vote pay nothing for the feature. That means two code paths through every function that touches a
tally, and a flag that must stay correct for the life of the schema.

## Decision

No mode. `properties.vote_weight` is `NOT NULL DEFAULT 1`, and every tally, quorum calculation, and
result **sums** weight rather than counting rows. When all weights are 1 — production today —
summing and counting are identical, so nothing branches and there is no unweighted path to
maintain. `member_votes.weight` is a **snapshot** taken at recording time, copied from
`properties.vote_weight` by the route rather than accepted from the client, so correcting a
property's weight later cannot silently rewrite a past tally. Integer shares, not floats, because
floating-point tallies accumulate error; a scheme that needs fractional shares expresses them by
scaling the integers instead. Zero is rejected — a property that should not vote belongs at
`status = 'inactive'`, not at a weight that quietly zeroes it out of every tally while still
appearing to participate.

## Consequences

`tallyVotes` takes an optional weight defaulting to 1 (`t[v.choice] += v.weight ?? 1`), so one
function serves both board and member votes: board votes carry no weight and behave exactly as
before, unchanged by this ADR. Member data lives in parallel fields — `MeetingDetail.memberAttendance`
and `totalActiveWeight`, `MotionDetail.memberVotes` and `memberTally` — beside the existing board
fields, rather than reshaping either concept into a discriminated union. That keeps every PR 2
consumer compiling unchanged, at the cost of two shapes to maintain per concept, a trade made
deliberately rather than forcing a union-narrowing branch into code that never asked for member
votes in the first place. `meetings.body` tells a consumer which pair to read; `totalActiveWeight`
is populated for every meeting, including board ones, so a consumer must gate on `body`, never on
that value being non-zero.

**Quorum is live; the tally beside it is not, and that is intentional.** Everything above makes the
tally a frozen snapshot: `member_votes.weight` is copied at recording time so a later weight
correction cannot rewrite a past result. Attendance gets the opposite treatment. `member_attendance`
has no weight column at all — the present-weight sum and `totalActiveWeight` both resolve from
`properties.vote_weight` and `properties.status` as they stand _now_, at read time, not as they
stood on the meeting date. So editing a property's weight, or moving it to `status = 'inactive'`,
changes the quorum line on an already-approved, already-published meeting, while the vote tally
next to it stays exactly as recorded. That is deliberate, not an oversight: quorum is a question
about whether the room (or the roster) had enough weight present to act, and the roster is a live
fact about the association, not a fact about the meeting — asking "was quorum met" with a
five-year-old weight table would answer a question nobody is asking. A vote result is the opposite:
it is a fact about what happened at the meeting, and must not drift when the roster changes later.
Both halves are correct for what they represent, but they are two different temporal models sitting
in the same published record, and a meeting can end up publishing a quorum line and a tally that
read as inconsistent with each other after a roster edit. Do not "fix" this by making the tally live
(the whole point above) or by snapshotting attendance (member_attendance intentionally carries no
weight column to snapshot); the asymmetry is the design.
