# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The public + homeowner website for the Valleys at Ashebrook neighborhood, branded
**"The Valleys at Ashebrook Residents"**. An admin-toggleable **official mode** switches the site to
official-HOA presentation — branding, footer disclaimer, and HOA-only surfaces like `/dues` are
driven by the `officialMode` site setting through `src/lib/site.ts`. An Astro SSR app
(`output: 'server'`) running on **Cloudflare Workers** via the `@astrojs/cloudflare`
adapter, backed by Cloudflare **D1** (SQLite via Drizzle ORM), **R2** (document files),
and **KV** (Astro sessions). Auth is **Better Auth** (email/password + admin plugin).
Homeowner sign-up is verified against the owner roster via a one-time code sent to the
phone/email already on file (email through Resend, SMS through Twilio), gated by
Cloudflare Turnstile captcha. Board members manage all content through the admin panel
at `/admin`. `SETUP.md` is the human deployment guide.

## Commands

```bash
npm run dev               # dev server at http://localhost:4321
npm run build             # SSR build to dist/
npm run check             # Astro + TypeScript type check
npm test                  # run jsdom component/unit tests (Vitest)
npm run test:watch        # Vitest in watch mode
npm run test:server       # Worker/D1 integration tests (vitest-pool-workers)
npm run format            # Prettier write; format:check is what CI enforces
npm run db:generate       # generate Drizzle migration files
npm run db:migrate:local  # apply migrations to local D1 (wrangler)
npm run db:migrate:remote # apply migrations to the live D1 database
npm run auth:generate     # regenerate Better Auth schema from config
npm run roster:import     # import owner roster for homeowner verification
npm run docs:import       # generate documents-manifest.json (see SETUP.md)
npm run docs:dedupe       # dry-run document duplicate report (see SETUP.md)
npm run deploy            # astro build && deploy the Worker
```

Run a single test file or name:

```bash
npx vitest run test/unit/example.test.ts
npx vitest run -t "shows an empty message"
# Worker integration tests:
npx vitest run --config vitest.workers.config.ts test/server/api.test.ts
```

Node version is pinned in `.nvmrc` (run `nvm use`). CI (`.github/workflows/build.yml`)
runs `format:check`, `check`, `test`, `test:server`, then `build` on every PR and push to
`main` — run these locally before pushing. On every merge (push) to `main`, the `Version`
workflow (`.github/workflows/version.yml`) tags the merge commit with an auto-incrementing
build number on the package.json major/minor release line (`v<x.y>.<n>`, e.g. `v0.1.4`).

## Architecture

**Rendering model.** Pages are `.astro` files in `src/pages/`. The site is full SSR
(`output: 'server'`). Public content (announcements, documents, dues) is read **server-side in
each page's frontmatter** — via `fetchAnnouncementsFor`/`fetchDocumentsFor`/`getDuesSettings` with
the role from `Astro.locals.authContext` — and passed as props to the display components, which
render server-side (no client directive) so the HTML ships with real content (SEO, first paint,
no-JS). The same-origin API endpoints under `src/pages/api/` back the admin panel and any client
refresh. Runtime bindings and secrets are read via `import { env } from 'cloudflare:workers'`.
Build-time `PUBLIC_*` vars are inlined by Astro from `.env`.

**Cloudflare bindings (`wrangler.toml`).** `DATABASE` (D1 `ashebrook-hoa`), `KV` (app
KV), `SESSION` (KV for Astro sessions — required by the `@astrojs/cloudflare` adapter, which
enables Astro sessions against a `SESSION` binding by default even though app auth uses Better
Auth's D1 sessions rather than `Astro.session`), `DOCS` (R2 `ashebrook-hoa-docs`).

**HTTP endpoints (all under `src/pages/api/`).**

- Public tier-filtered reads: `GET /api/content/{announcements,documents,dues,site}`
- Gated document download (R2, tier-checked): `GET /api/files/[id]`
- Board-only writes: `/api/admin/{documents,announcements,dues,site}` and
  `/api/admin/{properties,owners,members}`
  (`POST /api/admin/documents` hashes uploads, blocks exact duplicates, warns on near duplicates,
  and stores `content_hash` on success)
- Board-only duplicate review: `GET /api/admin/duplicates` lazy-backfills document
  hashes from R2 and returns exact/near groups; `POST /api/admin/duplicates` resolves
  selected duplicates by deleting their D1 rows and R2 objects
- Board handoff: `GET /api/admin/roles` (list current board) and
  `POST /api/admin/roles` — `{ action: 'promote', email }` or
  `{ action: 'demote', userId }` (409 if it's the last board member)
- Homeowner verification: `/api/verify/{request,confirm}`
- First-board bootstrap: `POST /api/bootstrap/board` — fail-closed, self-disables once a
  board account exists (410); requires the `x-bootstrap-secret` header + `BOARD_*` config
- Better Auth handler: `/api/auth/[...all]`

**Client helpers.**

- `src/lib/content.ts` — public reads (fetch `/api/content/*` endpoints).
- `src/lib/admin.ts` — board writes (fetch `/api/admin/*` endpoints), including typed
  document duplicate errors and duplicate-resolution helpers.
- `src/lib/types.ts` — shared shapes + `DEFAULT_*` fallbacks + `DOCUMENT_CATEGORIES` +
  the `Visibility` type + admin-write input normalizers (`normalize{Announcement,Property,Owner}Input`,
  `INPUT_LIMITS`) that trim/cap/validate and reject on write.
- `src/lib/site.ts` — branding constants + official-mode presentation logic (`navLinks`,
  `brandTag`, `accountNav`). The footer disclaimer and `/about` copy are board-editable via site
  settings, with the hardcoded `DISCLAIMER_SHORT`/`DISCLAIMER_LONG` as fallbacks: `disclaimer(site)`
  and `aboutParagraphs(site)` return the override or the built-in copy when blank. Pure module —
  usable in `.astro` files, islands, and unit tests.
- `src/lib/format.ts` — shared formatting helpers (unit-tested in `format.test.ts`).
- `src/lib/auth-client.ts` — Better Auth browser client.

**Server code (`src/server/`).** `auth/` (Better Auth config, Resend + Twilio senders),
`authz/` (`getAuthContext`, `resolveAuthContext` = middleware-first caller resolution with a
fail-closed fallback, `requireRole`, `requireBoard`, Turnstile check), `content/`
(`visibility.ts` = `tierAllows`/`visibleTiers`; `reads.ts`; `dedupe.ts` = SHA-256 exact
matching and metadata-only near-duplicate scoring), `db/` (Drizzle
`schema.ts` + `auth-schema.ts`, `client.ts` = `getDb(env)`, `migrations/`), `roster/`,
`verification/`, `http.ts` (`readJson`/`stringField` request-body helpers for the admin writes).

**Data model (D1 tables, `src/server/db/schema.ts`).** `announcements`, `documents` (metadata,
including nullable indexed `content_hash`; files in R2 under `documents/<id>/…`), `settings` (key/value singletons `dues` + `site`), and the
roster/verification tables — `properties` (homes) + `owners` (people, many per home; split in
migration `0002`), `user_property_links`, `property_verifications`, `manual_approval_queue` — plus
the Better Auth tables (`user`, `session`, `account`, `verification`). Migration `0004` adds
`documents.content_hash` and `documents_content_hash_idx` for duplicate detection. Migration
`0003` adds the uniqueness constraints (`properties.address_normalized`, `user_property_links (user_id,
property_id)`) and hot-path indexes. Migrations are applied with `npm run db:migrate:{local,remote}`
(via `wrangler`, which tracks applied files in D1 independently of Drizzle's `meta/` snapshots).
`0002`/`0003` were hand-authored SQL, but the Drizzle snapshot history has since been reconciled
through `0003`, so `npm run db:generate` diffs cleanly again for future changes. A user's role is a column on
the user record. Board membership is managed in the admin app's **Board members** panel: a board
member can promote another account to `board` and demote a board member (the last remaining board
member can't be demoted), making board handoff a supported workflow. A board member cannot escalate
their own access beyond `board`, and the _first_ board account is bootstrapped through a permanent,
fail-closed `POST /api/bootstrap/board` endpoint (self-disables once a board exists; guard logic in
`src/server/auth/seed-board.ts`, also re-exported as `seedBoard` from `scripts/seed-board.ts` — see
SETUP.md §6). These role changes are direct D1 writes, not the Better Auth
admin API — the admin plugin's impersonation/ban/set-role endpoints are not granted to board
sessions (see `src/server/auth/permissions.ts`).

**Roles & access.** Roles `visitor | homeowner | board`; content visibility tiers
`public | homeowner | board`. Access is enforced server-side and fail-closed (anonymous
→ visitor; unknown → most restrictive).

**Testing.**

- `npm test` — jsdom component/unit specs (`vitest.config.ts`); files under
  `test/unit/**` and component `*.test.tsx` files.
- `npm run test:server` — Worker/D1 integration tests via
  `@cloudflare/vitest-pool-workers` (`vitest.workers.config.ts`) under
  `test/server/**`. These import `{ env, applyD1Migrations }` from `cloudflare:test`
  and invoke handlers directly.

**Deploy.**

```bash
npm run build                                      # astro build → dist/
npx wrangler deploy -c dist/server/wrangler.json   # deploy the Worker
```

The root `wrangler.toml` intentionally has no `main` field — the adapter emits
`dist/server/wrangler.json` with `main`, `assets`, and bindings, which is what you
deploy with `-c`.

**Reference assets.** `design/Ashebrook HOA.dc.html` is a static design mockup kept as a visual
reference — it is not built or imported; don't edit it. Implementation plans and design specs live
in `docs/superpowers/{plans,specs}/`.

## Agents & docs automation

Project subagents live in `.claude/agents/`: `docs-updater` (keeps CLAUDE.md, README.md, SETUP.md,
SECURITY.md, CHANGELOG.md in sync with the code) and `code-reviewer` (reviews diffs against the
tier-enforcement / board-only / fail-closed access rules before merging). Docs freshness is
auto-checked at the end of every response turn by a read-only Stop hook in `.claude/settings.json`
(single pre-approved git command + Read/Grep/Glob — it never edits files). When it detects drift it
blocks the stop with specifics and the main session invokes `docs-updater` to fix exactly that drift.
