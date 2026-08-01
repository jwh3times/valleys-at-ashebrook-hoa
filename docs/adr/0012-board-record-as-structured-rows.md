# ADR 0012: Board Record Modeled as Structured Rows, Separate from Auth Users

**Status:** Accepted
**Date:** 2026-08-01

## Context

The board's meeting record — meetings, motions, roll-call votes, and standing resolutions — could
be kept as uploaded minutes documents in the existing document library, or modeled as D1 rows. The
site already stores documents well. But the stated value of this record is answering questions
across years ("what rule is in force", "how did each member vote", "when did we decide this"),
which a pile of PDFs cannot answer without a human reading all of them.

## Decision

Three things, all of which are expensive to reverse once real records exist:

1. **The board record is structured D1 rows**, not documents. A meeting may still link an uploaded
   minutes PDF, but the queryable record is the rows.
2. **A person and a term of service are separate tables** (`board_people`, `board_terms`). Votes,
   motions, and attendance reference the person. A member who serves, leaves, and returns is one
   identity with two terms, so voting history spans terms rather than fragmenting into per-term
   identities matched by name.
3. **`board_people` is independent of Better Auth `user` rows.** The Board access panel promotes
   and demotes site accounts; if votes referenced `user.id`, demoting someone would retroactively
   rewrite who served, and a member without a site login could not be recorded at all.

## Consequences

Deleting a person who has served is refused (409) — ending their term is the correct action; this
keeps history intact and mirrors `owners.property_id`. An optional `board_people.user_id` link
exists for display purposes but is never an authorization input. Roll-call votes name individuals
in a published record, which is intended for a board record but means `board_people.full_name`
must be added to the AI pseudonymizer roster (`loadRosterEntries`) before any meeting content
reaches the assistant — recorded here so the deferred AI wiring does not miss it.

**Also note:** `db.batch()` is D1's only atomicity primitive and has no prior use in this codebase.
PR 3 of this feature introduces it for multi-row resolution transitions. It is a new pattern here,
not an established one.
