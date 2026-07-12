# Repository Guidelines

## What This Is

This is the public and homeowner website for the Valleys at Ashebrook neighborhood, branded
**"The Valleys at Ashebrook Residents"**. An admin-toggleable **official mode** switches the site
to official-HOA presentation: branding, footer disclaimer, and HOA-only surfaces like `/dues` are
driven by the `officialMode` site setting through `src/lib/site.ts`.

The app is an Astro SSR app (`output: 'server'`) running on **Cloudflare Workers** via the
`@astrojs/cloudflare` adapter, backed by Cloudflare **D1** (SQLite via Drizzle ORM), **R2**
(document files), and **KV** (Astro sessions). Auth is **Better Auth** with email/password and the
admin plugin. Homeowner sign-up is verified against the owner roster via a one-time code sent to
the phone or email already on file, using Resend for email and Twilio for SMS, gated by Cloudflare
Turnstile. Board members manage all content through the admin panel at `/admin`. `SETUP.md` is the
human deployment guide.

## Project Structure & Module Organization

Source code lives in `src/`, with pages and API routes in `src/pages/`, shared UI in
`src/components/`, layouts in `src/layouts/`, client helpers in `src/lib/`, and server-only logic
in `src/server/`. Tests live in `test/`, public static assets in `public/`, automation scripts in
`scripts/`, and documentation in `docs/`. The `design/Ashebrook HOA.dc.html` file is a static
design mockup kept as visual reference only; it is not built or imported and should not be edited.
Current roadmap items live in `ROADMAP.md`; durable architecture decisions live in `docs/adr/`.

## Build, Test, and Development Commands

Use the Node version pinned in `.nvmrc` (`nvm use`) before installing dependencies.

```bash
npm run dev               # dev server at http://localhost:4321
npm start                 # same local Astro dev server
npm run build             # SSR build to dist/
npm run check             # Astro + TypeScript type check
npm test                  # jsdom component/unit tests (Vitest)
npm run test:watch        # Vitest in watch mode
npm run test:server       # Worker/D1 integration tests (vitest-pool-workers)
npm run format            # Prettier write
npm run format:check      # Prettier check, enforced by CI
npm run db:generate       # generate Drizzle migration files
npm run db:migrate:local  # apply migrations to local D1 with Wrangler
npm run db:migrate:remote # apply migrations to the live D1 database
npm run auth:generate     # regenerate Better Auth schema from config
npm run roster:import     # import owner roster for homeowner verification
npm run docs:import       # generate documents-manifest.json; see SETUP.md
npm run docs:dedupe       # dry-run document duplicate report; see SETUP.md
npm run corpus:import     # clean-replace R2/D1 doc + rag-twin corpus import; see SETUP.md §7
npm run deploy            # build and deploy with Wrangler
```

Run a single test file or test name with:

```bash
npx vitest run test/unit/example.test.ts
npx vitest run -t "shows an empty message"
npx vitest run --config vitest.workers.config.ts test/server/api.test.ts
```

CI (`.github/workflows/build.yml`) runs `format:check`, `check`, `test`, `test:server`, then
`build` on every PR and push to `main`; run the relevant checks locally before pushing. On every
merge to `main`, the Version workflow (`.github/workflows/version.yml`) tags the merge commit and
creates a GitHub release using the `package.json` major/minor release line. The project uses the
third semver segment as a build number (`<major>.<minor>.<build>`). The first tag for a new line
uses the package build value (`0.2.0` -> `v0.2.0`); later merges on the same line increment the
build tag (`v0.2.1`, `v0.2.2`, ...). When bumping major or minor, `x.y.0` remains valid and is not
incremented to `x.y.1` unless an `x.y.0` tag already exists.

## Coding Style & Naming Conventions

Use TypeScript and Astro conventions already present in the repo. Follow the existing Prettier
settings, keep indentation consistent with the file's current style, and prefer descriptive names
over abbreviations. Use `*.test.ts` and `*.test.tsx` for tests. Keep server-only code in
`src/server/` and avoid importing it into client-side modules.

## Architecture

**Rendering model.** Pages are `.astro` files in `src/pages/`. The site is full SSR. Public content
(announcements, documents, dues) is read server-side in each page's frontmatter via
`fetchAnnouncementsFor`, `fetchDocumentsFor`, or `getDuesSettings`, using the role from
`Astro.locals.authContext`, then passed as props to display components. Those components render
server-side without client directives so HTML ships with real content for SEO, first paint, and
no-JS behavior. Same-origin API endpoints under `src/pages/api/` back the admin panel and any
client refresh. Runtime bindings and secrets are read via `import { env } from 'cloudflare:workers'`.
Build-time `PUBLIC_*` vars are inlined by Astro from `.env`.

**Cloudflare bindings.** `wrangler.toml` defines `DATABASE` (D1), `KV` (app KV), `SESSION` (KV for
Astro sessions), `DOCS` (R2 document storage), and `AI` (Workers AI / AI Search binding). `SESSION`
is required by the `@astrojs/cloudflare` adapter, which enables Astro sessions against that binding
by default even though app auth uses Better Auth's D1 sessions rather than `Astro.session`. `AI`
backs the admin document assistant's retrieval via `env.AI.autorag(...)`, pointed at the
`AI_SEARCH_INSTANCE` var; answer generation additionally requires the `ANTHROPIC_API_KEY` secret.
The AI Search instance's R2 data source is scoped to the `rag/` folder only, so it indexes the
Markdown twins described below and never the human-readable originals.

**HTTP endpoints.** API routes live under `src/pages/api/`:

- Public tier-filtered reads: `GET /api/content/{announcements,documents,dues,site}`.
- Gated document download from R2 with tier checks: `GET /api/files/[id]`.
- Board-only writes: `/api/admin/{documents,announcements,dues,site}` and
  `/api/admin/{properties,owners,members}`. `POST /api/admin/documents` hashes uploads, blocks exact
  duplicates, warns on near duplicates, and stores `content_hash` on success; a confirmed
  near-duplicate upload also clears `keep_verified_at`/`keep_verified_by` on the existing documents
  it near-matches, so that duplicate group resurfaces for review.
- Board-only duplicate review: `GET /api/admin/duplicates` lazy-backfills document hashes from R2
  and returns exact or near groups, each member annotated with a `verifiedAt` timestamp; groups
  where every member is already kept-verified are hidden until a matching upload resets one.
  `POST /api/admin/duplicates` takes `{ action: 'resolve', keepIds, deleteIds }`, deletes each
  `deleteIds` document (D1 row + R2 object), and marks the surviving `keepIds` as kept-verified;
  `keepIds` must be non-empty and disjoint from `deleteIds`, while `deleteIds` may be empty for a
  keep-all/mark-reviewed resolution.
- Board handoff: `GET /api/admin/roles` lists current board; `POST /api/admin/roles` accepts
  `{ action: 'promote', email }` or `{ action: 'demote', userId }` and returns 409 when attempting
  to demote the last board member.
- Board-only document assistant: `POST /api/admin/assistant` (SSE) takes `{ question, history? }`
  and streams a Claude-generated, cited answer over the document library, retrieved via Cloudflare
  AI Search; document excerpts and chat history are pseudonymized (known resident PII replaced with
  consistent surrogates) before they reach Anthropic, document titles are never sent, and citations
  reference retrieved chunks back to real documents server-side. See SECURITY.md for the
  pseudonymization guarantees and limits. Retrieval is not tier-aware, which is why this endpoint
  stays board-only — see SECURITY.md and **Data model** below for the two-representation R2 layout
  retrieval runs over. `POST /api/admin/documents` generates the document's `rag/<uuid>.md` twin on
  upload via Workers AI `toMarkdown` and records `documents.rag_status` (`ok`/`unsupported`); a new
  upload is searchable at the next AI Search sync, and files that cannot be converted (scans, old
  `.doc`) are flagged "Not searchable" in the admin Documents panel via a board-only
  `GET /api/admin/documents`. Real OCR of scanned/image-only PDFs is the remaining gap.
- Homeowner verification: `/api/verify/{request,confirm}`.
- First-board bootstrap: `POST /api/bootstrap/board`, which is fail-closed, self-disables once a
  board account exists, and requires bootstrap secret/config values.
- Better Auth handler: `/api/auth/[...all]`.

**Client helpers.**

- `src/lib/content.ts` handles public reads from `/api/content/*` endpoints.
- `src/lib/admin.ts` handles board writes to `/api/admin/*` endpoints, typed document duplicate
  errors, and duplicate-resolution helpers.
- `src/lib/types.ts` contains shared shapes, `DEFAULT_*` fallbacks, `DOCUMENT_CATEGORIES`, the
  `Visibility` type, and admin-write input normalizers (`normalize{Announcement,Property,Owner}Input`,
  `INPUT_LIMITS`) that trim, cap, validate, and reject on write.
- `src/lib/site.ts` contains branding constants and official-mode presentation logic (`navLinks`,
  `brandTag`, `accountNav`). The footer disclaimer and `/about` copy are board-editable via site
  settings, with `DISCLAIMER_SHORT` and `DISCLAIMER_LONG` as fallbacks. `disclaimer(site)` and
  `aboutParagraphs(site)` return overrides or built-in copy when blank. This is a pure module usable
  in `.astro` files, islands, and unit tests.
- `src/lib/format.ts` contains shared formatting helpers, unit-tested in `format.test.ts`.
- `src/lib/auth-client.ts` contains the Better Auth browser client.

**Server code.** `src/server/` contains:

- `auth/`: Better Auth config, Resend and Twilio senders.
- `authz/`: `getAuthContext`, `resolveAuthContext` (middleware-first caller resolution with a
  fail-closed fallback), `requireRole`, `requireBoard`, and Turnstile checks.
- `content/`: `visibility.ts` (`tierAllows`, `visibleTiers`), `reads.ts`, and `dedupe.ts`
  (SHA-256 exact matching and metadata-only near-duplicate scoring).
- `db/`: Drizzle `schema.ts`, `auth-schema.ts`, `client.ts` (`getDb(env)`), and migrations.
- `roster/` and `verification/`: homeowner verification support.
- `http.ts`: `readJson` and `stringField` request-body helpers for admin writes.
- `ai/`: the board-only document assistant — `search.ts` (`retrieve`, Cloudflare AI Search/autorag
  retrieval), `pii.ts` (`buildPseudonymizer`, a reversible roster-based PII pseudonymizer with
  streaming de-anonymization), `sources.ts` (`toSources` maps retrieved chunks back to real D1
  document rows for citations; `docIdFromFolder` extracts a document's uuid from either R2 key shape,
  `documents/<uuid>/…` or `rag/<uuid>.md`), `anthropic.ts` (`getAnthropic`, Anthropic client + config
  guard), and `assistant.ts` (`answer`, `loadRosterEntries`; orchestrates retrieve -> pseudonymize ->
  Claude generation -> de-anonymized streamed output).

**Data model.** D1 tables are defined in `src/server/db/schema.ts`. They include `announcements`,
`documents` (metadata including nullable indexed `content_hash`, plus nullable `keep_verified_at`
and `keep_verified_by`, set when a board member explicitly keeps a document during duplicate
review; the document library uses 16 `DOCUMENT_CATEGORIES`, see `src/lib/types.ts`), `settings`
(key/value singletons `dues` and `site`), roster/verification tables (`properties`, `owners`,
`user_property_links`, `property_verifications`, `manual_approval_queue`), and Better Auth tables
(`user`, `session`, `account`, `verification`).

Every document has two R2 representations keyed by its D1 uuid, per
[ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md): the human-readable original
at `documents/<uuid>/<filename>`, served by `GET /api/files/<id>` with tier checks, and a derived
Markdown twin at `rag/<uuid>.md` that AI Search indexes (see **Cloudflare bindings** and the
board-only document assistant above). `docIdFromFolder` (`src/server/ai/sources.ts`) resolves a
document's uuid from either key shape so citations always point back to the real, tier-checked
download. The document library (444 human documents, 429 Markdown twins) is (re)built by the
operator-run `scripts/import-corpus.ts` as a clean replace; see SETUP.md §7.

Migration `0002` split homes and people into `properties` and `owners`. Migration `0003` adds
uniqueness constraints (`properties.address_normalized`, `user_property_links (user_id,
property_id)`) and hot-path indexes. Migration `0004` adds `documents.content_hash` and
`documents_content_hash_idx` for duplicate detection. Migration `0005` reconciles foreign keys and
enums on the roster/verification tables. Migration `0006` adds `documents.keep_verified_at` and
`documents.keep_verified_by`. Migration `0007` adds `documents.rag_status`. Migrations are applied
with `npm run db:migrate:{local,remote}` via
Wrangler, which tracks applied files in D1 independently of Drizzle's `meta/` snapshots. `0002` and
`0003` were hand-authored SQL, but the Drizzle snapshot history has been reconciled through `0003`,
so `npm run db:generate` should diff cleanly for future changes.

**Roles and access.** Roles are `visitor`, `homeowner`, and `board`; content visibility tiers are
`public`, `homeowner`, and `board`. Access is enforced server-side and fail-closed: anonymous users
resolve to visitor, unknown states resolve to the most restrictive behavior. A user's role is a
column on the user record. Board membership is managed in the admin app's **Board members** panel:
board members can promote another account to `board` and demote a board member, except the last
remaining board member cannot be demoted. A board member cannot escalate their own access beyond
`board`. The first board account is bootstrapped through the permanent fail-closed
`POST /api/bootstrap/board` endpoint, which self-disables once a board exists; guard logic lives in
`src/server/auth/seed-board.ts` and is re-exported as `seedBoard` from `scripts/seed-board.ts`.
These role changes are direct D1 writes, not Better Auth admin API calls. The Better Auth admin
plugin's impersonation, ban, and set-role endpoints are not granted to board sessions; see
`src/server/auth/permissions.ts`.

## Testing Guidelines

Add or update tests alongside behavior changes. Use `npm test` for jsdom-based unit and component
tests, and `npm run test:server` for Cloudflare Worker or D1 behavior. Test names should describe
visible behavior, for example `shows an empty state`. Prefer small focused tests over broad
snapshots unless the UI is intentionally static.

`npm test` uses `vitest.config.ts` and covers files under `test/unit/**` plus component
`*.test.tsx` files. `npm run test:server` uses `@cloudflare/vitest-pool-workers` with
`vitest.workers.config.ts` for files under `test/server/**`; these tests import `{ env,
applyD1Migrations }` from `cloudflare:test` and invoke handlers directly.

## Deploy

```bash
npm run build
npx wrangler deploy -c dist/server/wrangler.json
```

The root `wrangler.toml` uses `main = "src/worker.ts"` so the Worker can expose both Astro SSR
handling and the scheduled cleanup trigger. Manual deploys still use the adapter-emitted
`dist/server/wrangler.json`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, often lowercase, such as
`fix forgot password reset flow`. Keep commit subjects concise and action-oriented. PRs should
include a clear description, link related issues when applicable, and mention the commands run
locally. If a change affects UI or admin workflows, include screenshots or a short note describing
the user-visible result.

## Security & Configuration Tips

Do not commit real roster data, secrets, or production credentials. Keep environment examples in
`.env.example` and `.dev.vars.example`. Schema changes should go through Drizzle migrations, and
access control must stay server-side and fail closed.

Do not commit implementation scratchpads, security reviews, import artifacts, resident-data-derived
files, or detailed operational runbooks. Keep those under `private/`; public docs should describe
supported architecture and workflows, not exploit analysis, private execution notes, or
resident-data handling details.

## Agents & Docs Automation

Project subagents live in `.claude/agents/`: `docs-updater` keeps `AGENTS.md`, `README.md`,
`SETUP.md`, `SECURITY.md`, and `CHANGELOG.md` in sync with the code; `code-reviewer` reviews diffs
against tier-enforcement, board-only, and fail-closed access rules before merging.

Docs freshness is auto-checked at the end of every response turn by a read-only Stop hook in
`.claude/settings.json` using a pre-approved git command plus Read/Grep/Glob. It never edits files.
When it detects drift, it blocks the stop with specifics and the main session invokes
`docs-updater` to fix exactly that drift.
