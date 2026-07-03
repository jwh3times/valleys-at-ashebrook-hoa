# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The public + homeowner website for the Valleys at Ashebrook HOA. An Astro SSR app
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
runs `format:check`, `check`, `test`, then `build` on every push and PR — run these
locally before pushing.

## Architecture

**Rendering model.** Pages are `.astro` files in `src/pages/`. The site is full SSR
(`output: 'server'`); dynamic data is fetched from same-origin API endpoints under
`src/pages/api/`. Runtime bindings and secrets are read via
`import { env } from 'cloudflare:workers'`. Build-time `PUBLIC_*` vars are inlined by
Astro from `.env`.

**Cloudflare bindings (`wrangler.toml`).** `DATABASE` (D1 `ashebrook-hoa`), `KV` (app
KV), `SESSION` (KV for Astro sessions), `DOCS` (R2 `ashebrook-hoa-docs`).

**HTTP endpoints (all under `src/pages/api/`).**
- Public tier-filtered reads: `GET /api/content/{announcements,documents,dues,site}`
- Gated document download (R2, tier-checked): `GET /api/files/[id]`
- Board-only writes: `/api/admin/{documents,announcements,dues,site}` and
  `/api/admin/{owners,members}`
- Board handoff: `GET /api/admin/roles` (list current board) and
  `POST /api/admin/roles` — `{ action: 'promote', email }` or
  `{ action: 'demote', userId }` (409 if it's the last board member)
- Homeowner verification: `/api/verify/{request,confirm}`
- Better Auth handler: `/api/auth/[...all]`

**Client helpers.**
- `src/lib/content.ts` — public reads (fetch `/api/content/*` endpoints).
- `src/lib/admin.ts` — board writes (fetch `/api/admin/*` endpoints).
- `src/lib/types.ts` — shared shapes + `DEFAULT_*` fallbacks + `DOCUMENT_CATEGORIES` +
  the `Visibility` type.
- `src/lib/auth-client.ts` — Better Auth browser client.

**Server code (`src/server/`).** `auth/` (Better Auth config, Resend + Twilio senders),
`authz/` (`getAuthContext`, `requireRole`, `requireBoard`, Turnstile check), `content/`
(`visibility.ts` = `tierAllows`/`visibleTiers`; `reads.ts`), `db/` (Drizzle
`schema.ts` + `auth-schema.ts`, `client.ts` = `getDb(env)`, `migrations/`), `roster/`,
`verification/`.

**Data model (D1 tables).** `announcements`, `documents` (metadata; files in R2 under
`documents/<id>/…`), `settings` (key/value singletons `dues` + `site`), plus Better
Auth tables (`user`, `session`, `account`, `verification`, roster/owner tables). A
user's role is a column on the user record. Board membership is managed in the admin
app's **Board members** panel: a board member can promote another account to `board`
and demote a board member (the last remaining board member can't be demoted), which
makes board handoff a supported workflow. A board member cannot escalate their own
access beyond `board`, and the *first* board account is still bootstrapped out-of-band
via `scripts/seed-board.ts` (see SETUP.md). These role changes are direct D1 writes,
not the Better Auth admin API — the admin plugin's impersonation/ban/set-role
endpoints are not granted to board sessions (see `src/server/auth/permissions.ts`).

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
