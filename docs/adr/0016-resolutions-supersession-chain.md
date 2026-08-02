# ADR 0016: A Resolution Is a Durable Record with an Enforced Supersession Chain

**Status:** Accepted
**Date:** 2026-08-01

## Context

Boards adopt standing rules — pool hours, parking, architectural guidelines — outside the meeting
record's motion-by-motion granularity. The obvious design is to treat a standing rule as a flag on
whichever passed motion created it: no new table, and the meeting record already has motions.
But "what rule is in force today" then has no direct answer — it requires replaying every motion
ever passed and tracking which one most recently touched a given topic, in application code, on
every read. And an amended rule has no structured link to what it replaced; the relationship
between an old policy and its replacement would live only in prose, if it's written down at all.

## Decision

Resolutions are their own table, not a motion flag. Amending a resolution creates a **new**
resolution row that supersedes the old one, so "what's in force" is a single indexed query
(`status = 'in_force'`) rather than a replay, and the history is a walkable chain via
`supersedes_id`. Motions stay separate and untouched by this: a resolutions-only model would
collapse "the board voted on this and it passed" into the resolution itself, discarding what the
board _declined_ to do — a motion that failed leaves no resolution, but it still happened, and the
meeting record is where that lives.

Integrity is **enforced, not assumed**, at several layers rather than trusted to caller discipline:

- `UNIQUE(supersedes_id)` — two resolutions cannot both claim to replace the same predecessor. That
  constraint is what makes the chain a chain and not a tree; without it, "the current rule" would
  stop being well-defined.
- `ON DELETE RESTRICT` on the self-referencing foreign key — a superseded resolution cannot be
  deleted out from under the successor that points at it, because the chain is what makes the
  history readable, and a dangling link would defeat that.
- Server-side preconditions on every transition: the target resolution must exist, must currently
  be `in_force` (for `supersede`/`repeal`) or `draft` (for `adopt`, and for the new resolution side
  of `supersede`), and — for `supersede` — the two ids must differ, since a resolution superseding
  itself is not a chain, it's a cycle of one.
- A visited-set in the chain walker regardless of the above. The unique index and the RESTRICT
  foreign key make a cycle unreachable through the admin API, but the read path does not get to
  trust that: a rendering function that can infinite-loop given bad data is unacceptable even when
  today's write path cannot produce that data. Defense here costs one `Set` per call.

`supersede` performs both halves of an amendment — the new resolution taking effect with
`supersedes_id` set, and the predecessor's status flipping to `superseded` — in a single
`db.batch()`, D1's only atomicity primitive available here. Either both writes land or neither
does; there is no state where a new resolution is in force with no predecessor marked superseded,
or vice versa.

Status is **transition-only**: `PATCH` can edit a resolution's number, title, body, effective date,
and visibility, but cannot write `status`, `supersedes_id`, or `adopted_by_motion_id` directly.
Those fields are maintained exclusively by the three named actions — `adopt`, `supersede`,
`repeal` — each gated by its own preconditions. A resolution's lifecycle is a small, explicit state
machine (`draft` -> `in_force` -> `superseded` | `repealed`), and the only way to move between
states is through the action that models that specific transition, not a general-purpose field
edit that happens to also work.

## Consequences

A `draft` state exists so a resolution can be written, reviewed, and revised before it takes effect
without ever appearing as a live row — nothing reads a draft except the board-only admin list.
`effective_date` is nullable, and is meant to be nullable only while the resolution is a draft; a
resolution that has ever been `in_force` has a real effective date, since `adopt` and `supersede`
both require one as an argument. That invariant is enforced, not just aspirational: `PATCH` refuses
to clear `effective_date` with a `409` unless the resolution's current status is `draft` — without
that check, a board caller could adopt a resolution and then blank its effective date right back
out through the general-purpose edit path, which is exactly the state the required-effective-date
rule on `adopt`/`supersede` exists to prevent.

Repeal touches exactly one row — the repealed resolution's own status — and leaves every
`supersedes_id` link, on that row and on any row pointing at it, untouched. A repealed rule's
lineage stays fully readable; repeal is a statement about whether the rule still binds, not about
its place in history.

The public read masks an out-of-tier link in **both directions along the chain**, not only the one
direction the obvious implementation would catch. Walking backwards, a predecessor outside the
caller's tier renders as `{ id: null, number: null, title: null, visible: false }` — an
unidentified but present earlier resolution — rather than being omitted, because omitting it would
misrepresent the chain as shorter than it is, and naming it would leak a record the caller isn't
entitled to see. `ResolutionDetail.supersedesId` is subject to the identical check: it is set to
the real id only when that same predecessor is visible, and null otherwise, even though
`supersedesId` and `chain[0]` are populated by separate fields on the returned shape. The two are
deliberately derived from the same tier check on the same row (`chain[0]?.visible`) rather than
computed independently, so they cannot drift apart and disagree about whether the immediate
predecessor is visible. The chain itself is treated as the single source of truth for "does this
resolution supersede something" — `supersedesId` is a convenience projection of that same fact, not
a second fact that could say something different. The inverse direction gets the same treatment:
`supersededByNumber` names a successor only when that successor is itself visible to the caller,
so a board-only amendment does not announce its own existence by name on a homeowner-visible
predecessor's page.

The only resolution that can be deleted is a `draft`. Anything that has ever been `in_force` is
history: even a repealed resolution stays in the table permanently, because deleting it would
break any successor's `supersedes_id` link (prevented by the RESTRICT foreign key regardless) and
would erase the record of a rule that genuinely governed the association for some period of time.

`adopted_by_motion_id` is `ON DELETE SET NULL`, deliberately more permissive than the self-
referencing chain link — a resolution must not become undeletable forever just because a motion
once adopted it. But `SET NULL` on its own would let `DELETE /api/admin/motions` (and, by
cascade, `DELETE /api/admin/meetings` on a draft meeting) silently blank an `in_force`
resolution's adoption provenance, with no way to restore it afterward: `PATCH` deliberately cannot
write `adopted_by_motion_id`, so the loss would be unrecoverable through the API. Both delete
routes therefore refuse with `409` while a resolution still cites the motion (or, for a meeting,
any motion it owns) — a motion a resolution cites cannot be deleted while that citation stands, so
adoption provenance is durable rather than silently detachable.
