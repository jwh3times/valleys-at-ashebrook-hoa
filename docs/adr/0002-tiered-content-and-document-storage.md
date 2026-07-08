# ADR 0002: Tiered Content and Document Storage

**Status:** Accepted
**Date:** 2026-07-08

## Context

The site needs public, homeowner-only, and board-only content. Documents also need
file storage, duplicate detection, and safe download behavior on Cloudflare
Workers.

## Decision

Store content metadata in D1 and document bytes in R2. Every content row carries a
visibility tier: `public`, `homeowner`, or `board`. Server-side read helpers apply
the tier check from the caller's auth context before returning content.

Document downloads go through a same-origin route that checks visibility before
reading R2. Uploads use a server allowlist, canonical content types, content hash
deduplication, and safe `Content-Disposition` behavior.

## Consequences

- The client never decides whether hidden content is visible.
- Google Drive import, homeowner uploads, OCR, and search should reuse this D1/R2
  pipeline rather than create a parallel document store.
- Large-file uploads may need a signed R2 flow later because Worker request bodies
  are capped.
