# Roadmap

**Updated:** 2026-07-08

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

### 7. OCR, Search, and Admin AI Assistant

**Status:** Not implemented
**Gate:** Dedicated spec
**Likely size:** Large to extra large

Potential future document intelligence work: OCR, embeddings, vector search, and
an admin assistant over the document archive. This should be designed as its own
sub-project because it affects storage, privacy, indexing, cost, and operator
expectations.

## Operations Backlog

### 8. Enable HSTS at the Cloudflare Zone

**Status:** Not implemented
**Gate:** Operator action in Cloudflare
**Likely size:** Small

The app already sends the baseline security headers it can control. HSTS should
be enabled at the Cloudflare zone level after confirming HTTPS is stable for the
production domain and any subdomains that need to remain reachable.

### 9. Rename GitHub and Cloudflare Resources

**Status:** Deferred
**Gate:** Maintainer action
**Likely size:** Small code update plus operator work

The resident rebrand is complete in the app, but some resource names still use
the original HOA-oriented names. Renaming the GitHub repository, D1 database, or
R2 bucket is operationally risky and should be done only when the maintainer is
ready to coordinate dashboard changes, Wrangler config updates, and a deploy.

## Completed Work

Completed work is intentionally not duplicated here. See `CHANGELOG.md` for shipped changes and
`docs/adr/` for durable architecture and operating decisions.
