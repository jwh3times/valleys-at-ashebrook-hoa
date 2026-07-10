# ADR 0007: Document Deduplication Policy

**Status:** Accepted
**Date:** 2026-07-08

## Context

The imported document archive contains exact duplicates and renamed variants.
Uploads also need protection against adding new duplicate documents.

## Decision

Store a nullable SHA-256 `content_hash` on documents and use a shared
deduplication engine for upload checks, the admin duplicates panel, and the bulk
cleanup script.

Exact duplicates are byte-identical matches. Uploads of exact duplicates are
blocked. Near duplicates are metadata-based matches and are never auto-deleted;
they require an explicit board decision.

Automatic cleanup may collapse exact duplicates only within the same visibility
tier. Exact duplicates spanning different tiers are treated as a policy decision
and must be reviewed manually.

Duplicate groups carry a per-document "kept/verified" state (`keep_verified_at`,
`keep_verified_by`). When a board member resolves a group in the admin panel they
may keep one or more members; the kept members are recorded as verified and the
group is hidden from the panel while every member is verified. Uploading a
confirmed near-duplicate clears the verified state on the existing documents it
matches, so the group resurfaces for re-review. Byte-identical uploads remain
blocked, so verification never needs to reset for an exact upload.

## Consequences

- New byte-identical duplicates are stopped before R2/D1 writes.
- Existing imports can be cleaned without data loss for same-tier exact groups.
- Cross-tier and near-duplicate cases remain visible to the board instead of being
  resolved by code.
- Reviewed groups stop nagging the board once every member is kept-verified.
- A new near-duplicate upload re-opens the affected group by resetting the
  verified state on its existing matches.
- Edge case (accepted): if two documents are each verified in separate
  near-reviews and a later hash backfill proves them byte-identical, that exact
  group stays hidden because both members are verified. This is rare and
  consistent with the board having already chosen to keep both.
