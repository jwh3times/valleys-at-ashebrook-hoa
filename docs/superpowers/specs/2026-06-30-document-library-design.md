# Tiered Content & Document Library — Design Spec

**Date:** 2026-06-30
**Status:** Draft for review
**Sub-project:** B (Tiered content on D1/R2 + document library) — builds on A (Identity & Roles)

---

## 1. Program context

Sub-project A delivered identity and roles (Better Auth on Cloudflare Workers +
D1; `visitor`/`homeowner`/`board`; `getAuthContext`, `requireRole`,
`requireOwnerAccess`, `requireBoard`). A's final task cut the board login to
Better Auth but left the content managers (announcements, documents, dues, site)
writing to **Firestore**, which a Better-Auth session cannot authorize — so
content management is currently non-functional (`TODO(subproject-B)` markers).

Sub-project B does two coupled things:

1. **Re-platform the content data layer** off Firestore onto **D1** (metadata /
   content) and **R2** (document files), rewiring the public read helpers and the
   admin managers, and removing the last Firebase dependency. (The site was never
   deployed on Firebase — the project ID is still a placeholder — so there is no
   live Firestore data to export; this is re-implementing the data-access code.)
2. **Add the tiered document library:** per-item **visibility** (`public` /
   `homeowner` / `board`) on documents and announcements, role-gated file
   downloads, admin management of documents + tiers, and importing the ~289 MB /
   489-file Drive archive as tiered, downloadable files.

Platform is unchanged from A: Astro on `@astrojs/cloudflare` v14 (SSR on Workers),
D1, R2, KV, Better Auth. `env` is accessed via `import { env } from
'cloudflare:workers'`; authorization is always server-side.

---

## 2. Goals and non-goals

### Goals
1. All content (announcements, documents, dues, site settings) lives in D1; all
   document files live in R2. No Firestore, no Firebase dependency remains.
2. A shared `visibility` tier (`public`/`homeowner`/`board`) governs documents and
   announcements; reads are filtered server-side by the caller's role.
3. Role-gated document downloads: the public tier is downloadable by anyone;
   homeowner/board files require an authorized session, enforced per request.
4. The board admin can fully manage content again — CRUD announcements (with
   visibility), documents (upload/edit/delete + category + visibility), dues, and
   site settings.
5. The Drive archive is imported into the library with visibility + category
   auto-proposed from folder paths, board-reviewable.

### Non-goals (this sub-project)
- OCR / text extraction / embeddings / vector search — those belong to sub-project
  C (the AI assistant). The library serves files as-is.
- Per-owner private data (dues balances, individual violation status) — A's
  substrate supports it; the UI/tables are a later sub-project.
- Homeowner-facing document upload — board manages all content.

---

## 3. Data model (D1)

Shared type: `Visibility = 'public' | 'homeowner' | 'board'` (a text enum column).

- `documents` — id (uuid), title, category (from `DOCUMENT_CATEGORIES`),
  visibility, r2_key, filename, size_bytes, content_type, uploaded_at, updated_at.
- `announcements` — id, title, body, date (ISO), pinned (bool), visibility.
- `settings` — key (`'dues' | 'site'`) primary key, value (JSON text), updated_at.
  (Re-platforms the Firestore `settings/dues` and `settings/site` singletons; the
  `DEFAULT_*` fallbacks in `types.ts` still apply when a row is absent.)

Reuse `DOCUMENT_CATEGORIES` and the `DEFAULT_*` shapes from `src/lib/types.ts`;
add `Visibility` and a `visibility` field to the `Announcement` and `DocumentItem`
types. Migrations via drizzle-kit into `src/server/db/migrations` (same mechanism
as A).

---

## 4. File storage (R2)

- One R2 bucket bound as `DOCS` (wrangler `r2_buckets`).
- Object key convention: `documents/<uuid>/<sanitized-filename>`.
- The `documents.r2_key` column stores the key; the file bytes never live in D1.

---

## 5. Gated file serving

A single Worker endpoint `GET /api/files/[id]` (Astro API route, `prerender =
false`, `import { env } from 'cloudflare:workers'`):

1. Load the `documents` row by id (404 if missing).
2. If `visibility === 'public'`: stream the R2 object with a cacheable
   `Cache-Control`.
3. Else resolve `getAuthContext(request, env)`; allow if the caller's role tier is
   ≥ the document's visibility (board sees all; homeowner sees public+homeowner;
   visitor/anon sees public only). Otherwise `403`.
4. On allow, stream the R2 object body with its `content_type` and a
   `Content-Disposition` for the original filename.

Rationale: one code path, authorization always enforced server-side, no
bearer-URL leakage. R2→Worker streaming has no egress cost. **Rejected
alternative:** short-lived presigned URLs (leak risk during the validity window,
extra S3-credential complexity).

A small shared helper `tierAllows(role, visibility): boolean` (role rank ≥
visibility rank; `board` ≥ `homeowner` ≥ `public`) is used by both serving and
list filtering.

---

## 6. Tier-aware reads

Public content is fetched from tier-filtered Worker endpoints, not Firestore:

- `GET /api/content/announcements?limit=` — returns announcements with
  `visibility` ≤ caller's tier, newest-first, pinned floated.
- `GET /api/content/documents` — returns documents with `visibility` ≤ caller's
  tier, grouped by category; each item's download link points at `/api/files/[id]`.
- `GET /api/content/dues` and site settings — public config from `settings`.

`src/lib/content.ts` is rewired: the public React islands (`AnnouncementsList`,
`DocumentsList`, `DuesInfo`) call these endpoints instead of Firestore. Filtering
is server-side; the client only ever receives what its session is entitled to.

---

## 7. Admin re-platforming (board)

Rewire `src/lib/admin.ts` and the four managers off Firestore onto board-only
D1/R2 endpoints, each gated by `requireBoard` (from A's `api-guards.ts`):

- `POST/PATCH/DELETE /api/admin/documents` — create (R2 upload + metadata), update
  (title/category/**visibility**, and the previously-missing metadata edit),
  delete (R2 object + row). Upload accepts the file (multipart or a two-step
  signed-PUT; see §11 open item — default: the Worker receives the file and puts
  it to R2).
- `POST/PATCH/DELETE /api/admin/announcements` — CRUD incl. `visibility` and
  `pinned`.
- `PUT /api/admin/dues`, `PUT /api/admin/site` — upsert the `settings` singletons.

The manager components (`DocumentsManager`, `AnnouncementsManager`, `DuesManager`,
`SiteManager`) call these endpoints using the Better Auth session (cookies) rather
than the Firebase SDK. `DocumentsManager` gains a **visibility** selector and
metadata edit; `AnnouncementsManager` gains a **visibility** selector.

---

## 8. Drive import (library ingest — no OCR)

A script (`scripts/import-documents.ts`) that:

1. Walks `private/HOA_files/**` (gitignored).
2. For each file, computes **visibility** and **category** from its folder path via
   a pure, unit-tested mapping (`pathToDocMeta(relPath): { visibility, category }`)
   derived from the inventory:
   - public: `Governing Documents`, `Gov Docs`, `Maps`, blank `Forms`, `Owner FAQ`,
     `Portal Login How-To`
   - homeowner: `Meetings`/minutes, `Budgets`, `Financials` (summaries),
     `Insurance`, `Assessments`, `Collections` (policy)
   - board: `Legal & Collections`, `Covenant Enforcement`/violations, `Member
     Correspondence`, `Bank Statements`, `Check Images`, `Invoice Images`,
     `Financials-Board`, `Contracts`, `Tax return`, `Owner Transaction History`
   - default when unmatched: **board** (fail-safe to most-restricted).
3. Uploads the file to R2 and inserts a `documents` row.
4. Writes an import manifest the board reviews; tiers are adjustable afterward in
   the admin UI. Because files are served gated, a mis-tag can only under-expose to
   authorized users, never leak to the public.

The R2 upload / D1 insert is an operator step (needs the R2 + D1 account, like A's
cloud steps). `pathToDocMeta` is unit-tested independently.

---

## 9. Firebase removal

After the read/write paths are on D1/R2:
- Delete `src/lib/firebase.ts`; remove the `firebase` dependency from
  `package.json`; delete `firestore.rules`, `storage.rules`, and their
  `firebase.json` references (keep hosting config only if still relevant, else
  replace with the R2/Workers deployment notes).
- Update `SETUP.md`: remove the Firebase project/Firestore/Storage/rules steps; add
  "create the R2 bucket" and the document-import step.
- Remove `ConfigNotice`'s Firebase-config checks or repoint them at the new stack
  as appropriate.

---

## 10. Security considerations

- Authorization is server-side on every read and file fetch; the client never
  receives content above its tier.
- The gated file route is the only way to fetch homeowner/board files; R2 is not
  publicly listable and objects are not served by public URL.
- Admin endpoints are board-only via `requireBoard`.
- Import defaults unmatched paths to `board` (most-restricted), so a new/unknown
  folder never accidentally publishes sensitive material.
- Uploads validate content type and a size cap (mirror A/Storage's 25 MB PDF-ish
  rule, generalized for the library's file types).

---

## 11. Open items (resolved defaults; flag at planning)
- **Upload transport:** default is the admin Worker receiving the file and putting
  it to R2 (simple; fits typical HOA file sizes). If large uploads become an issue,
  a signed-PUT flow can be added later.
- **Public-tier caching:** public files get a moderate `Cache-Control`; gated files
  are `private, no-store`.

---

## 12. Testing strategy
- **Unit:** `pathToDocMeta` (folder→visibility/category incl. board default);
  `tierAllows(role, visibility)`.
- **Worker/D1 integration:** file serving — public served to anon; a homeowner-tier
  file 403s for anon/visitor and 200s for homeowner/board; a board file only for
  board. Tier-filtered list endpoints return the correct subset per role. Admin
  document/announcement/dues/site endpoints reject non-board (401/403) and perform
  CRUD for board.
- **Component:** the four managers (previously untested) — visibility/category
  selectors, upload, edit, delete happy paths with mocked endpoints; `DocumentsList`
  / `AnnouncementsList` render the tier-filtered payloads and correct download links.

---

## 13. Out of scope
OCR/embeddings/vector search and the AI assistant (sub-project C); per-owner private
data UI; homeowner-facing uploads. These consume B's storage/visibility model but
are specified separately.
