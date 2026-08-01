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
