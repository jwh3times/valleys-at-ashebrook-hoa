# ADR 0010: OCR of Scanned Documents Runs as an Operator Offline Job

**Status:** Accepted
**Date:** 2026-07-12

## Context

Scanned / image-only PDF uploads have no text layer, so `env.AI.toMarkdown`
produces no usable text and the document is stored `rag_status = 'unsupported'`
(downloadable, but not assistant-searchable). Making them searchable requires
OCR: rasterizing PDF pages to images, then transcribing the images.

Doing this automatically on upload inside the Worker is not viable today: there
is no supported way to rasterize an existing PDF's pages to images in a Worker
(Browser Rendering's navigate-and-screenshot path is a known dead end; the
`mupdf.js` WASM route has an open Workers-compatibility issue; a pdf.js-in-
Browser-Rendering workaround is undocumented DIY). Sending raw scanned pages to
a third-party OCR service would be new, un-pseudonymized egress of resident
documents, which the assistant's privacy posture avoids.

## Decision

OCR runs as an **operator-run offline script** (`scripts/ocr-scanned.ts`),
mirroring the corpus importer: it selects unsupported PDFs from D1, rasterizes
pages locally with `pdfjs-dist` + `@napi-rs/canvas`, transcribes each page via
the **Workers AI REST API** (a vision model — keeping the vision step inside
Cloudflare), applies a minimum-text quality gate, and on `--commit` writes the
`rag/<uuid>.md` twin and sets `rag_status = 'ok'`. It is dry-run by default.

## Consequences

- Scanned uploads are searchable only after the operator runs the job and the
  next AI Search sync indexes the new twin — not automatically on upload.
- No document content leaves the operator's machine + Cloudflare; the existing
  privacy boundary (only pseudonymized excerpts reach Anthropic) is preserved.
- A poor OCR result is left `'unsupported'` rather than writing a garbage twin.
- Revisit on-upload/automatic OCR if Cloudflare ships a supported in-Worker PDF
  rasterization primitive.
