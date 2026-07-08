# Document Deduplication & Upload-Time Prevention — Design Spec

**Date:** 2026-07-06
**Status:** Draft for review

---

## 1. Context

The `documents` table (D1) + R2 object store hold the neighborhood's document
archive. The bulk of it was bulk-loaded by `scripts/import-documents.ts`, which
walked `private/HOA_files/`, minted a UUID per file, uploaded it to R2 under
`documents/<id>/<safeName>`, and inserted a metadata row. That import performed
**no deduplication**, and the source tree contains many duplicates — the same
file living in two folders (`Financials-Board/2022/08/August Financials.pdf` vs
`Financials/2022/08 Financials.pdf`), copy suffixes (`…Customize Settings(1).pdf`
vs `…Customize Settings.pdf`), an ARC form under both `Architectural Requests
(ARC)/` and `Forms/ARC/`, and re-saved/renamed variants (a misspelled "Vallesy"
collection-policy file). Those duplicates are now live on the site.

The board-facing upload path (`POST /api/admin/documents`) likewise writes a fresh
UUID + R2 object on every upload with no similarity check, so nothing prevents new
duplicates from accumulating.

The `documents` table has **no content-hash column today** — rows are keyed only by
`id` / `r2_key` / `filename`.

Platform is unchanged: Astro SSR on `@astrojs/cloudflare` (Workers), D1 via Drizzle,
R2 (`DOCS` binding). `env` via `import { env } from 'cloudflare:workers'`; all
authorization is server-side and fail-closed; board writes go through `requireBoard`.

---

## 2. Goals and non-goals

### Goals

1. **Clean up existing duplicates** already on the site (R2 + D1), across all file
   types, without data loss.
2. **Prevent new duplicates** at upload time: block a byte-identical re-upload, warn
   on a near-duplicate.
3. Provide the board an ongoing, in-app way to find and resolve duplicates.
4. One detection engine shared by every surface so the logic cannot drift.

### Non-goals

- Content/text extraction, OCR, embeddings, or semantic similarity — near-duplicate
  detection is **metadata-only** (filename/title tokens + size + content-type). A
  content- or AI-based pass is a possible later phase, explicitly out of scope here.
- Deduplicating anything other than documents (announcements, roster, etc.).
- Homeowner-facing upload — the board manages all content, unchanged.

---

## 3. Definitions

- **Exact duplicate** — two documents whose file bytes are identical, i.e. equal
  **SHA-256**. Deterministic, zero false positives.
- **Near duplicate** — two documents judged similar by a metadata score:
  normalized filename/title **token overlap** + **file-size proximity** + **same
  content-type**, above a tuned threshold. Heuristic; may have false positives, so
  near-duplicates are **never** auto-acted — always board-confirmed.

---

## 4. Data model change

Add one column to `documents` (migration `0004`):

- `content_hash` — `text`, **nullable**, **not unique**, with index
  `documents_content_hash_idx`.
  - **Nullable** so the ~500 existing rows can be backfilled lazily/asynchronously
    rather than in one blocking migration.
  - **Not unique** — the app-level upload guard (not a DB constraint) prevents new
    exact duplicates. A unique index would (a) fail during concurrent lazy-backfill
    writes and (b) reject the legitimate "identical bytes intentionally published at
    two different visibility tiers" case, which §7 handles as manual review.
  - Indexed for the O(1) exact-match lookup on the upload hot path.

Stored as lowercase hex SHA-256. Drizzle snapshot history is reconciled through
`0003`, so `npm run db:generate` will diff this column cleanly.

---

## 5. Shared engine — `src/server/content/dedupe.ts`

Pure, environment-agnostic, unit-tested. Powers the upload guard, the admin panel
endpoints, and the cleanup script identically.

- `sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string>` — via
  `crypto.subtle.digest('SHA-256', …)`, available in both the Worker runtime and the
  Node script (`globalThis.crypto`).
- `normalizeName(name: string): string[]` — lowercase; strip the extension; strip
  copy suffixes (`(1)`, `(2)`, ` - Copy`); strip timestamp stamps
  (`_20241216-1453`, trailing `-1`); split on non-alphanumerics into tokens; drop
  empty tokens. (Ubiquitous tokens like `valleys`/`ashebrook`/`hoa` are kept but
  contribute little signal because they appear in nearly every name.)
- `tokenSimilarity(a: string[], b: string[]): number` — Sørensen–Dice / Jaccard on
  the token sets, in `[0,1]`.
- `sizeSimilar(a: number, b: number): boolean` — identical, or within a small
  tolerance (e.g. ≤ 2%).
- `nearScore(a: DocLike, b: DocLike): number` — combines `tokenSimilarity`, size
  proximity, and equal content-type into a single score; a module-level
  `NEAR_THRESHOLD` decides "near". `DocLike = { title, filename, sizeBytes,
contentType }`.
- `groupExact(docs): Group[]` — group by `contentHash` (ignores null hashes); only
  groups of size ≥ 2 returned.
- `groupNear(docs): Group[]` — pairwise `nearScore ≥ NEAR_THRESHOLD`, merged into
  connected components; excludes pairs already in the same exact group.

`Group = { members: DocRef[], suggestedKeepId: string, reason?: string }` where
`DocRef` carries `{ id, title, filename, category, visibility, sizeBytes,
uploadedAt }`.

**Keep tie-break** (`suggestedKeepId`, used by auto-collapse and as the panel
default): cleanest filename wins — no `(1)`/timestamp suffix, then shortest
filename, then earliest `uploadedAt`.

---

## 6. Surface 1 — Upload guard (`POST /api/admin/documents`)

Behavior: **block exact, warn on near.** After the existing validation
(`requireBoard`, title/category/visibility/type/size checks) and before writing to
R2:

1. Compute `h = sha256Hex(bytes)`.
2. **Exact:** `SELECT … FROM documents WHERE content_hash = h`. If any row →
   respond **409** `{ error: 'exact-duplicate', existing: { id, title, category,
visibility } }`. Nothing is written to R2 or D1. No override.
3. **Near:** load lightweight metadata (`title, filename, size_bytes,
content_type`) for all documents; compute `nearScore` against the upload. If any
   `≥ NEAR_THRESHOLD` **and** the form field `confirmDuplicate !== 'true'` →
   respond **409** `{ warning: 'near-duplicate', similar: [{ id, title, filename,
category, visibility }] }`. Nothing written.
4. Otherwise (clean, or `confirmDuplicate=true`) → store to R2 and insert the row as
   today, **including `contentHash: h`**.

Client (`src/lib/admin.ts` `uploadDocument`): gains a `confirmDuplicate = false`
argument that sets the form field. On a 409 it parses the body: `exact-duplicate`
→ throw a typed error the UI renders as a hard block naming the existing doc;
`near-duplicate` → surface the similar list with an **"Upload anyway"** action that
re-calls `uploadDocument(..., true)`. `DocumentsManager.tsx` renders both states.

The near scan is a metadata pass over all documents (hundreds of rows, selected
columns only) — acceptable per-upload cost at this scale.

---

## 7. Surface 2 — Admin "Duplicates" panel

Two board-only endpoints under `src/pages/api/admin/duplicates.ts`:

- **`GET /api/admin/duplicates`** — lazy-backfills then reports.
  - **Lazy backfill:** for documents with `content_hash IS NULL`, stream the R2
    object (`env.DOCS.get`), compute SHA-256, and `UPDATE` the row. This is **capped
    per request** (e.g. N objects) to stay within Worker CPU/subrequest limits; the
    response includes `{ remaining: <count> }` so the UI can call again until zero.
  - Returns `{ exact: Group[], near: Group[], remaining: number }` from the shared
    engine over all rows (those still null-hashed are simply not yet groupable).
- **`POST /api/admin/duplicates`** — `{ action: 'resolve', keepId, deleteIds }`.
  `requireBoard`; validate `keepId`/`deleteIds` are real document ids and disjoint;
  delete each `deleteId` from **R2 and D1** (same delete path as the existing
  `DELETE` handler). Return **204**.

UI: a new **Duplicates** section on the admin page.

- **Exact groups** render with the suggested keep pre-selected and a one-click
  "keep suggested, delete the rest."
- **Near groups** require the board to choose the keep and which members to delete,
  or dismiss the group (no destructive default).

---

## 8. Surface 3 — Bulk cleanup script — `npm run docs:dedupe`

For the immediate one-time cleanup of the imported archive without clicking through
the panel group-by-group. New `scripts/dedupe-documents.ts`, wired as
`docs:dedupe`, mirroring `docs:import`'s dry-run-then-`--commit` shape and its
`node <wrangler.js>` invocation pattern.

- **Hash source = the local `private/HOA_files/` tree** (fast local reads; no ~500
  R2 downloads). Each local file maps to its D1 row via
  `private/documents-manifest.json` (`relativePath → id/r2Key`). This is the
  intentional shortcut: it covers exactly the import-originated files, which are the
  duplicates in question. Files uploaded through the panel _after_ the import are
  not on local disk and are **not** in scope for the script — they are covered by
  the panel's lazy backfill (§7) and the upload guard (§6). The two surfaces divide
  cleanly.
- **Dry run (default):** hash every local file, run the shared engine, and write
  `private/dedupe-report.json` = `{ exact: Group[], near: Group[] }`. Also emit the
  `UPDATE documents SET content_hash = … WHERE id = …` statements. Print a summary.
- **`--commit`:** apply the `content_hash` back-write (D1), then **delete the
  confirmed exact-duplicate extras** — per the §9 safety rules — from R2
  (`wrangler r2 object delete`) and D1. Near-duplicate groups are reported only,
  never deleted by the script.

---

## 9. Safety rules (destructive-action guardrails)

Apply to both the script's `--commit` and the panel's exact one-click:

1. **Auto-collapse only within one visibility tier.** Exact duplicates that share a
   visibility get auto-resolved (the surviving copy is byte-identical, so there is no
   data loss). Exact duplicates spanning **different** tiers (e.g. one `public`, one
   `board`) are **never** auto-deleted — they are surfaced for manual review, because
   choosing which tier survives is a policy decision.
2. **Keep tie-break** (§5): cleanest filename → shortest → earliest `uploadedAt`.
3. **Near-duplicates are never auto-acted** — script reports them, panel requires an
   explicit board choice, upload warn is overridable.
4. Deleting a duplicate removes its `/api/files/<id>` URL. Acceptable for duplicates;
   the kept id (the tie-break winner) stays stable so the surviving link works.

---

## 10. Testing

- **Unit (`npm test`, jsdom):**
  - `dedupe.ts` — `sha256Hex` on known bytes; `normalizeName` strips `(1)` and
    `_20241216-1453` stamps; `tokenSimilarity`/`nearScore` cross the threshold on
    the real dupe pairs (Financials variants, ARC-in-two-folders, "Vallesy" typo) and
    stay below it on genuinely-distinct docs; `groupExact`/`groupNear` component
    merging and `suggestedKeepId` tie-break.
  - `DocumentsManager` — exact-block message and near-warn "Upload anyway" flow.
- **Server (`npm run test:server`, Workers pool):**
  - `POST /api/admin/documents` — blocks exact (409 `exact-duplicate`, no R2 write),
    warns near (409 `near-duplicate`) then accepts with `confirmDuplicate=true`
    (201 + `content_hash` persisted), passes clean uploads.
  - `GET /api/admin/duplicates` — board-only; lazy-backfills a null hash; returns
    exact + near groups with `remaining`.
  - `POST /api/admin/duplicates` — board-only; `resolve` deletes the named ids from
    both R2 and D1 and leaves `keepId` intact.

---

## 11. Rollout

1. Migration `0004` (`content_hash` + index) applied local then remote.
2. Ship the shared engine + upload guard + panel (prevents _new_ dupes immediately).
3. Run `npm run docs:dedupe` (dry run), review `dedupe-report.json`, then
   `--commit` to collapse the existing same-tier exact duplicates.
4. Board works the panel for cross-tier exact groups and near-duplicate groups.
5. `docs-updater` refreshes CLAUDE.md/SETUP.md (new column, endpoint, script, npm
   command).
