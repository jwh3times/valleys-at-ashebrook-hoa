# ADR 0014: Meeting Approval Is a Status Gate, Not a Visibility Tier

**Status:** Accepted
**Date:** 2026-08-01

## Context

Minutes are drafted at a meeting, then formally approved by a motion at the following meeting —
approval is a separate event, often weeks after the content first exists as rows. Publishing a
meeting record therefore asks two independent questions: has this been approved, and who is
allowed to see it. The existing content model (`src/server/content/visibility.ts`) only answers
the second question — a `public`/`homeowner`/`board` tier per item — because documents and
announcements are published the moment a board member saves them. Meetings need a workflow state
in front of that tier.

## Decision

Two axes, not one. `meetings.status` (`draft`/`approved`) records the workflow fact; `visibility`
records the intended audience once approved. The public read helpers, `fetchMeetingsFor` and
`fetchMeetingFor`, filter `status = 'approved'` **unconditionally, including for board callers** —
there is no role that sees a draft through the public path. A board member reads drafts only
through the separate `fetchAdminMeetings`/`fetchAdminMeeting` path behind `/api/admin/meetings`.
`assembleMeetingDetail`, shared by both paths, holds no status or tier logic itself; filtering
happens once, in the two callers.

`status` is transition-only. `PATCH /api/admin/meetings` cannot write `status`, because approval is
a transition that must maintain `approved_at`/`approved_by`/`approved_by_motion_id` alongside the
flip, not a field a general edit can silently move. Moving between draft and approved goes through
two explicit actions, `approve` and `unapprove`, which maintain those three provenance columns:
`approve` 409s if the meeting is already approved, and `unapprove` clears all three, because
provenance describing an approval that no longer holds would be a false record. Deleting an
approved meeting is refused (409) for the same reason a document library keeps published content
around — an approved record is not a draft that can simply be discarded. The same discipline
applies one level down: `PATCH /api/admin/motions` cannot write `sequence`, because the server
assigns it as `max + 1` scoped to the meeting, and a client-supplied value would let two motions
occupy the same position.

Roll-call tallies are always derived from the stored `board_votes` rows; a motion's `outcome` is
board-entered and never computed, because passage thresholds vary by motion type and bylaw, and
quorum is not modelled by this schema.

## Consequences

Board members have two places to look — the public pages for approved content, the admin panel for
everything — which is the intended cost of this design. The alternative, a single `visibility`
field alone, would let one dropdown change publish an unapproved motion to the public site, and
would record nothing about whether the underlying approval vote ever happened; that failure mode
is exactly the one this ADR removes. The unconditional filter in the public read helpers is
deliberately stricter than the tier system alone: even a board caller using the public path cannot
see a draft, so a future bug in tier resolution cannot leak one.

Because tallies are derived and `outcome` is not, a report of "12 votes cast, 8 in favor" and the
motion's recorded "Passed" can diverge from a naive majority read — that is expected wherever
supermajority or quorum rules apply, and is a call for board judgment, not something this schema
tries to encode.
