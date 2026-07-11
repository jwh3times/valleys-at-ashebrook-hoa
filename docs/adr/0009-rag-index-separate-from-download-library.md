# ADR 0009: RAG Index Corpus Separate from the Download Library

**Status:** Accepted (implementation pending)
**Date:** 2026-07-10

## Context

The board document assistant (ADR 0008) retrieves over a Cloudflare AI Search
index. The historical archive contains scanned PDFs and legacy Office formats
(`.doc`, `.msg`, `.rtf`) that AI Search indexes poorly or not at all, and AI
Search enforces a hard 4 MB per-file limit. Indexing the human-readable files
directly — the prior approach, where AI Search pointed at the same
`documents/<uuid>/…` objects residents download — couples retrieval quality to
each file's format and size, and silently drops anything scanned or oversized.

Separately, those same documents must remain downloadable by residents in their
original human-readable form (PDF/doc/xlsx). The two needs are in tension: what
searches well (clean text) is not what a resident should download (the real
signed/scanned document).

## Decision

Keep **two representations** of every document, linked by the document's D1
`uuid`:

- **Human-readable original** — R2 `documents/<uuid>/<filename>`, served by
  `GET /api/files/<uuid>` with tier checks (unchanged). This is the only
  representation residents ever see or download.
- **RAG Markdown** — R2 `rag/<uuid>.md`, a derived text-only rendering
  (text-extracted; scanned pages OCR'd offline before upload). Cloudflare AI
  Search is scoped to index **only the `rag/` prefix**.

Citations resolve by uuid, not by the indexed object: retrieval → uuid parsed
from the `rag/<uuid>.md` key → D1 row → citation `href` `/api/files/<uuid>`. The
assistant therefore always cites the human-readable original and never exposes
the Markdown. `docIdFromFolder` (`src/server/ai/sources.ts`) extracts the uuid
from both `documents/<uuid>/…` and `rag/<uuid>.md`.

The library is (re)built by a **clean replace**: the deduplicated archive is
imported as fresh D1 rows + R2 objects, each with a board-assigned category (the
full granular category set, not the original five) and a visibility tier. The
Markdown corpus is a derived artifact, never surfaced to residents and never a
`documents` row.

## Consequences — constraints future work MUST preserve

1. **The two representations must stay in sync, per uuid.** Every code path that
   creates a document (`POST /api/admin/documents`) must also produce its
   `rag/<uuid>.md`; every path that removes one (`DELETE`, duplicate resolution
   in `/api/admin/duplicates`) must remove both. Born-digital uploads can be
   text-extracted in-Worker; a **scanned** upload needs OCR (Workers AI, or an
   explicit "not searchable" flag) — a scan with no Markdown is silently absent
   from assistant retrieval while still appearing in the library. This ongoing
   sync is the primary maintenance obligation of this design; without it the
   index drifts from the library. Detailed hook points live in the private
   integration handoff, not this public record.

2. **The index is NOT tier-aware; the assistant MUST remain board-only.** AI
   Search retrieves across all indexed Markdown regardless of each document's
   visibility, and returns chunk **text** that the model uses to compose its
   answer. Only the citation *link* is tier-checked (`/api/files`), not the
   retrieved text. Consequently, if the assistant were ever exposed to
   homeowners or the public, board-only document text (financials, per-owner
   correspondence, legal/collections) could appear verbatim inside an answer
   even though the citation download would correctly return 403 — a tier
   bypass through the answer body. Exposing the assistant beyond `board`
   therefore requires, at minimum, one of:
   - a per-caller retrieval filter that restricts the index to the tiers the
     caller may see (e.g. per-document visibility metadata on each `rag/*.md`
     object, filtered at query time), or
   - separate per-tier indexes queried by role,

   plus a re-review of the PII-pseudonymization boundary (ADR 0008), since the
   index holds un-pseudonymized resident PII. **Do not relax the board-only gate
   without implementing one of the above.**

3. Retrieval quality no longer depends on source file format or the 4 MB limit,
   and the resident download experience is fully independent of indexing.
