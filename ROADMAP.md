# Roadmap

**Updated:** 2026-07-31

This is the current list of work that is not implemented yet. It replaces the older private review
notes and now-removed implementation handoff docs.

Previously identified partial implementation items have been completed or closed by explicit
operating decisions. Shipped work is tracked in `CHANGELOG.md`; durable decisions are recorded
under `docs/adr/`.

## How to Use This Roadmap

- Treat each product item below as requiring its own spec before build.
- Keep security, authorization, and visibility checks server-side.
- Add or update tests with every behavior change.
- Update `CHANGELOG.md` when an item ships.
- Add an ADR when an item changes a durable architecture or operating decision.

## Product Backlog

### 1. Google Docs, Sheets, and Drive Import

**Status:** Not implemented
**Gate:** Dedicated spec
**Likely size:** Large

Allow a board member to import a Google Doc, Sheet, or Drive file into the
existing document library. The likely shape is a board-only import endpoint that
exports Google Docs to PDF and Sheets to XLSX, then stores the artifact through
the same R2 plus D1 document pipeline used by normal uploads.

Decisions to settle:

- Shared service account versus per-board-member OAuth.
- Snapshot import versus live synchronization.
- Export size cap and failure behavior.
- How imported filenames, titles, categories, and visibility are chosen.

### 2. Per-Owner Private Data

**Status:** Not implemented
**Gate:** Board privacy decision
**Likely size:** Large

Add private homeowner data such as dues balances or violations. This should not
start until the board explicitly decides that publishing per-owner private data
through the site is appropriate.

Expected shape:

- New D1 tables keyed to owner or property records.
- Homeowner endpoints that filter by the caller's verified `propertyIds`.
- Board CRUD in the admin app.
- No client-side filtering as an authorization boundary.

### 3. Roster Quality of Life

**Status:** Not implemented
**Gate:** Dedicated spec
**Likely size:** Medium per sub-item

Improve the roster admin workflow beyond the current CRUD and CLI import path.

Candidate items:

- Bulk import UI with preview, diff, and commit steps.
- Ownership-transfer workflow that deactivates old owners and adds new owners in
  one board action.
- Optional `Account #` capture on owner or property records, with a migration and
  admin form support.

### 4. Homeowner Uploads and Large Files

**Status:** Dormant
**Gate:** Actual need for homeowner uploads or files over the Worker body cap
**Likely size:** Medium

The current document workflow is board-managed. Revisit this only if homeowners
need to upload files, or if board uploads hit the Worker request body cap. The
likely design is a signed R2 upload flow with server-side completion and
visibility checks.

### 5. Tenant and Renter Accounts

**Status:** Not implemented
**Gate:** Board policy decision
**Likely size:** Large

Support non-owner resident accounts. This needs a product decision first because
tenant access affects identity proofing, owner delegation, roster data, and
visibility rules.

Expected decisions:

- Owner-invited access versus board-approved access.
- Whether tenants can view homeowner-only documents.
- How tenant access expires or is revoked.

### 6. Online Payments

**Status:** Not implemented
**Gate:** Official adoption and payment-provider decision
**Likely size:** Large

The site can display dues information in official mode, but it does not process
payments. Payment work should wait until the board adopts the site for official
HOA use and selects a provider.

### 7. Assistant Upload-Time RAG Twin + OCR

**Status:** Partially implemented — see `CHANGELOG.md` for the shipped board-only AI
document assistant (Cloudflare AI Search retrieval + Claude generation, PII
pseudonymization, hybrid document/general-knowledge answers) and
[ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md) for the
retrieval-vs-download index split.
**Gate:** Dedicated spec
**Likely size:** Medium

Remaining work the shipped assistant does not yet cover:

- Scanned/image-only PDF uploads are addressed via an operator-run offline job
  (`npm run ocr:scanned`; see [ADR 0010](./docs/adr/0010-ocr-scanned-documents-operator-job.md)),
  not automatically on upload — there is no supported way to rasterize an existing
  PDF's pages to images inside a Worker today. Revisit on-upload/automatic OCR if
  Cloudflare ships a supported in-Worker PDF rasterization primitive.
- New uploads become searchable only at the next AI Search sync (default ≤6h), not
  immediately on upload; triggering a sync automatically after upload is a possible
  future refinement.

### 8. AI CC&R Compliance Report

**Status:** Partially implemented — see `CHANGELOG.md` v0.3.39 for the shipped board-only
governing-documents report (six curated templates plus a freeform topic, planned
sub-query retrieval, streamed five-section report with `[Source N]` citations, and
saved report history in the `reports` table).
**Gate:** Dedicated spec for the remaining compliance angle
**Likely size:** Medium

The "what do our CC&Rs say about X" half is shipped. Remaining work:

- The **compliance** angle — "where are our current practices out of step with the
  governing documents" — is only covered indirectly by the report's Gaps section.
  Real gap analysis needs a source of truth for current practice (minutes, dues
  history, enforcement records) to compare the documents against, so it likely
  waits on item 9.
- Refinements deferred from the shipped build: a retention policy for the
  PII-bearing `reports.content_md` (hang it off the existing scheduled cleanup
  trigger), structured outputs for the sub-query planner instead of parsing JSON
  out of the response text, pagination for the saved-report list, and a
  short-circuit when retrieval returns nothing so no generation call is made.

_Product angle: a standalone AI governing-documents report is a sellable
artifact on its own._

### 9. Minutes and Motion/Vote Records

**Status:** Not implemented
**Gate:** Dedicated spec
**Likely size:** Medium to Large

Model the board record, not the transcript: meetings, motions, movers, seconds,
vote tallies, and a resolutions book, as new D1 tables with board CRUD in the
admin app. Publication is tiered like all other content — approved minutes
visible at the homeowner tier, drafts and working records board-only, enforced
server-side.

_Product angle: the durable record is the product; the data model is the moat._

### 10. Election Management

**Status:** Not implemented
**Gate:** Official adoption and a board decision
**Likely size:** Large

Statutory ballots, quorum tracking, and proxy handling. Like online payments,
this only carries weight if the board adopts the site for official HOA use, so
it is gated the same way. Eligibility builds on the existing verified-homeowner
roster and `user_property_links` for one-ballot-per-property rules.

_Product angle: per-election pricing on top of a subscription._

### 11. Reserve Planning Tracker

**Status:** Not implemented
**Gate:** Dedicated spec and board-supplied reserve study data
**Likely size:** Large

Track reserve components, useful and remaining life, and funding projections.
This is an entirely new domain model with the least reuse of existing
infrastructure, so it sits last in this group. It needs real reserve study data
from the board to be more than an empty shell.

_Product angle: a price-ladder module for a future product tier._

## Operations Backlog

### 12. Enable HSTS at the Cloudflare Zone

**Status:** Not implemented
**Gate:** Operator action in Cloudflare
**Likely size:** Small

The app already sends the baseline security headers it can control. HSTS should
be enabled at the Cloudflare zone level after confirming HTTPS is stable for the
production domain and any subdomains that need to remain reachable.

### 13. Rename GitHub and Cloudflare Resources

**Status:** Deferred
**Gate:** Maintainer action
**Likely size:** Small code update plus operator work

The resident rebrand is complete in the app, but some resource names still use
the original HOA-oriented names. Renaming the GitHub repository, D1 database, or
R2 bucket is operationally risky and should be done only when the maintainer is
ready to coordinate dashboard changes, Wrangler config updates, and a deploy.

## Product Opportunities

This section records the longer-range product vision so it is not lost. Nothing
here is backlog. This repo is the v1 pilot of a possible self-managed HOA
governance product; Ashebrook remains a single-community deployment, and any
multi-tenant productization requires its own decision, recorded as an ADR,
before this repo's architecture bends toward it.

- **COI tracking.** Certificate-of-insurance tracking for vendors. Weak as a
  standalone feature but a good shared module across this product and LeaseBook.
  The build-once-ship-twice decision belongs at the product level, not in this
  repo's backlog.
- **Board certification courses.** Document library plus quiz plus certificate
  PDF. Not software revenue — treat as top-of-funnel marketing for a future
  product. No backlog entry.
- **Monetization notes.** Pricing observations kept here so the backlog entries
  above stay product-neutral: election management supports per-election pricing
  ($200–500/election) on top of a subscription and is the best-margin item;
  the reserve planning tracker is a price-ladder module sold to the same buyer
  under the same login.

## Completed Work

Completed work is intentionally not duplicated here. See `CHANGELOG.md` for shipped changes and
`docs/adr/` for durable architecture and operating decisions.
