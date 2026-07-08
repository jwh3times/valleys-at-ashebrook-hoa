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

## Consequences

- New byte-identical duplicates are stopped before R2/D1 writes.
- Existing imports can be cleaned without data loss for same-tier exact groups.
- Cross-tier and near-duplicate cases remain visible to the board instead of being
  resolved by code.
