# ADR 0008: AI Assistant Privacy Gate

**Status:** Accepted
**Date:** 2026-07-08

## Context

A future admin assistant could answer questions over the document archive, but
that work would introduce new privacy and third-party data-flow concerns. The
older design notes included implementation details for an unbuilt assistant and
are not appropriate as public roadmap material.

## Decision

Do not build an AI document assistant without a fresh, explicit spec and privacy
review. Any assistant must be board-only, fail closed, cite gated source
documents, and document exactly what content leaves Cloudflare for generation.

Known resident PII must be protected before any third-party model call. Public
docs may describe this only at a high level until an implementation is accepted.

## Consequences

- The current public roadmap can mention OCR/search/assistant work without
  publishing a detailed implementation plan.
- Future assistant work has a clear entry gate instead of inheriting stale design
  notes.
- Security and setup docs must be updated before any assistant is enabled.
