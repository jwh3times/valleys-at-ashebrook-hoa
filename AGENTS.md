# Repository Guidelines

## What This Is

The public and homeowner website for the Valleys at Ashebrook neighborhood, branded **"The
Valleys at Ashebrook Residents"**. It is resident-run and **not** an official HOA site by default.

Two site settings gate everything that would make it one:

- **`officialMode`** switches the site to official-HOA presentation — branding, footer disclaimer,
  and HOA-business surfaces like `/dues` and homeowner proxy grants at `/proxies`. Driven through
  `src/lib/site.ts`. See [ADR 0005](./docs/adr/0005-resident-mode-and-official-mode.md) and
  [ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md).
- **`liveVotingEnabled`** is the separate, default-off, fail-closed gate for conducted elections
  and member-motion voting. Both flags must be literal JSON `true` for any open or cast.

The app is an Astro SSR app (`output: 'server'`) on **Cloudflare Workers** via the
`@astrojs/cloudflare` adapter, backed by **D1** (SQLite via Drizzle), **R2** (document files), and
**KV** (Astro sessions). Auth is **Better Auth** with email/password and the admin plugin.
Homeowner sign-up is verified against the roster by a one-time code to the phone or email already
on file (Resend for email, Twilio for SMS, gated by Cloudflare Turnstile). Board members manage
all content at `/admin`. `SETUP.md` is the human deployment guide.

## Project Structure & Module Organization

Source lives in `src/`: pages and API routes in `src/pages/`, shared UI in `src/components/`,
layouts in `src/layouts/`, client helpers in `src/lib/`, and **server-only logic in
`src/server/`** — never import it into a client-side module. Tests live in `test/`, public assets
in `public/`, automation in `scripts/`, documentation in `docs/`.

`design/Ashebrook HOA.dc.html` is a static design mockup kept as visual reference only; it is not
built or imported and should not be edited. Roadmap items live in `ROADMAP.md`; durable
architecture decisions in `docs/adr/`; the association's domain vocabulary in `CONTEXT.md`.

## Where to look next

This file carries what binds every change. Detail lives in `docs/agents/`, one file per surface —
load the one your task touches.

| Load this                                                      | When you are                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`http-endpoints.md`](./docs/agents/http-endpoints.md)         | Adding or changing an API route — guard order, status codes, race re-checks.  |
| [`data-model.md`](./docs/agents/data-model.md)                 | Changing a table, column, FK, or CHECK constraint.                            |
| [`migrations.md`](./docs/agents/migrations.md)                 | Writing a migration, or applying one to local or production D1.               |
| [`roster-and-access.md`](./docs/agents/roster-and-access.md)   | Touching authorization, the party roster, Access Grants, or the write freeze. |
| [`voting-and-ballots.md`](./docs/agents/voting-and-ballots.md) | Touching elections, motions, ballots — or anything naming `ballot_choices`.   |
| [`module-map.md`](./docs/agents/module-map.md)                 | Looking for where a helper or server module lives and what it owes.           |
| [`ci-and-release.md`](./docs/agents/ci-and-release.md)         | Debugging CI, bumping a dependency, or cutting a version.                     |
| [`issue-tracker.md`](./docs/agents/issue-tracker.md)           | Reading or writing GitHub issues (`gh` CLI conventions).                      |
| [`triage-labels.md`](./docs/agents/triage-labels.md)           | Applying a triage label.                                                      |
| [`domain.md`](./docs/agents/domain.md)                         | Exploring the codebase — which domain docs to read first.                     |

`docs/adr/` records the decisions behind all of it; [`docs/adr/README.md`](./docs/adr/README.md)
indexes every ADR with a one-line title.

## Build, Test, and Development Commands

Use the Node version pinned in `.nvmrc` (`nvm use`) before installing dependencies.

```bash
npm run dev               # dev server at http://localhost:4321
npm start                 # same local Astro dev server
npm run build             # SSR build to dist/
npm run check             # TypeScript 7 + Astro type checks
npm run types:worker      # regenerate Cloudflare runtime/binding types
npm run types:worker:check # fail if generated Worker types drifted, enforced by CI
npm test                  # jsdom component/unit tests (Vitest)
npm run test:watch        # Vitest in watch mode
npm run test:server       # Worker/D1 integration tests (vitest-pool-workers)
npm run format            # Prettier write
npm run format:check      # Prettier check, enforced by CI
npm run lint              # type-aware Oxlint
npm run lint:fix          # apply Oxlint's safe fixes
npm run sync:agents       # regenerate the Claude skills and Codex agents
npm run sync:agents -- --check # fail if generated agent trees drifted, enforced by CI
npm run lint:coercions    # fail on `Number(x) || <default>`, enforced by CI
npm run lint:migrations   # migrations directory is well-formed and contiguous, enforced by CI
npm run db:migrate:local  # apply migrations to local D1 with Wrangler
npm run db:migrate:remote # apply migrations to production D1 — the ONLY path
npm run auth:generate     # regenerate Better Auth schema from config
npm run sync:main         # fast-forward this checkout AND private/ to the latest default branch
npm run bootstrap:private # clone the private ops companion into gitignored private/ via 1Password
npm run bootstrap:env     # materialize .env/.dev.vars for this worktree
npm run roster:import     # import owner roster for homeowner verification
npm run secrets:put -- <NAME> # deploy one Worker secret from 1Password; never prints the value
npm run docs:import       # generate documents-manifest.json; see SETUP.md
npm run docs:dedupe       # dry-run document duplicate report; see SETUP.md
npm run corpus:import     # clean-replace R2/D1 doc + rag-twin corpus import; see SETUP.md §7
npm run ocr:scanned       # OCR scanned/"unsupported" PDF uploads into search twins
npm run verify:invariants # ADR 0022 migration invariant gate; pass --local or --remote
npm run roster:backfill   # ADR 0022 roster backfill; dry-run by default
npm run shadow:sweep      # ADR 0022 offline shadow sweep over every account
npm run deploy            # build and deploy with Wrangler
npm run deploy:check      # dry-run the built Worker's generated Wrangler config
```

**`npm run db:generate` is NOT part of the workflow** — the Drizzle snapshot chain is abandoned
(#257) and its output replays the #248 rebuilds. Hand-author migrations; see
[`migrations.md`](./docs/agents/migrations.md).

Run a single test file or test name with:

```bash
npx vitest run test/unit/example.test.ts
npx vitest run -t "shows an empty message"
npx vitest run --config vitest.workers.config.ts test/server/api.test.ts
```

### Two TypeScript programs

There are two on purpose. `tsconfig.json` covers the Astro/Workers app — `src/` and the
Workers-pool tests in `test/server/` — while `tsconfig.node.json` covers code that never runs on
Workers (`scripts/`, the jsdom/node tests in `test/unit/`, and root config files). **Each config
excludes what the other includes, so adding a new Node-side path means adding it to both.**

`worker-configuration.d.ts` supplies both programs with compatibility-date-aligned Cloudflare
runtime and binding types generated from `wrangler.toml` and `.env.example`; `src/ambient.d.ts`
augments the generated `Env` with secrets and test-only bindings. Run `npm run types:worker` after
changing either source — CI runs `types:worker:check` so drift cannot merge.

`npm install` also runs the root `postinstall`, which installs the locked TypeScript 6 Astro
checker under `vendor/astro-check-ts6/`. The root compiler remains TypeScript 7; `npm run check`
generates Astro's project types, runs the root compiler over **both** programs, then uses that
isolated checker only for `.astro` diagnostics until Astro supports the TypeScript 7 programmatic
API.

## Coding Style & Naming Conventions

Follow the TypeScript and Astro conventions already in the repo and the existing Prettier
settings, keep indentation consistent with the file's current style, and prefer descriptive names
over abbreviations. Use `*.test.ts` / `*.test.tsx` for tests.

### Never default a coerced numeric form value with `||`

`Number('')` and `Number('0')` are both `0`, so `Number(x) || 1` cannot tell a blank field from a
typed zero and silently substitutes the default — and because the substitution happens before the
request is sent, **the server never sees the `0` to reject it**. Check for blank first:

```ts
const raw = form.field.trim();
const value = raw === '' ? undefined : Number(raw);
```

This has bitten twice: a lot's `vote_weight` set to 1 when the board typed 0, and a candidate's
tally recorded as a real 0 when the field was left blank, destroying the `NULL` ("not recorded")
vs `0` ("recorded as zero") distinction. `npm run lint:coercions` fails CI on the pattern; a
deliberate case needs a trailing `coercion-ok` comment with a reason. It catches the shape, not
every way blank can be conflated with zero.

### Linting

**`.oxlintrc.jsonc` enables the `correctness` category wholesale and nothing else.** Every other
category was measured against this tree and found dominated by rules that are wrong for it — the
measurements are recorded in the config file itself, and **re-measuring is the bar for enabling a
category**. A few high-signal rules are opted in by name (`react/exhaustive-effect-dependencies`,
`eslint/no-shadow`, `promise/always-return`), and a `correctness` rule can be turned off by name
with a documented reason, either globally or scoped to one file via `overrides`.

`correctness` carries `react/set-state-in-effect`, which is a **shape check, not a timing
analysis**: it flags any effect calling a component-scope function that transitively sets state,
even when every `setState` happens after an `await`, but it never inspects a function declared
_inside_ the effect callback. So a clean `npm run lint` is not proof no effect sets state
synchronously.

The documented **mount-fetch shape** is what both that rule and
`react/exhaustive-effect-dependencies` expect, and what six components already use (admin
`ReportsManager`, `MembersManager`, `MeetingsManager`, `BoardServicePanel`, `ResolutionsManager`,
and member `ProxyManager`): a `useCallback`-memoized loader declared as the effect's dependency,
started from a function declared inside the effect callback, with an unmount/cleanup flag guarding
the eventual write.

## Architecture

Detail lives in `docs/agents/` — see [Where to look next](#where-to-look-next). What follows binds
every change regardless of surface.

**Rendering model.** Pages are `.astro` files in `src/pages/`; the site is full SSR. Public content
is read server-side in each page's frontmatter (`fetchAnnouncementsFor`, `fetchDocumentsFor`,
`getDuesSettings`, `fetchMeetingsFor`, `fetchResolutionsFor`, `fetchElectionsFor`, …) using the
role from `Astro.locals.authContext`, then passed as props to display components that render
**without client directives**, so HTML ships with real content for SEO, first paint, and no-JS
behavior. Same-origin API endpoints under `src/pages/api/` back the admin panel and client
refresh. Runtime bindings and secrets come from `import { env } from 'cloudflare:workers'`;
build-time `PUBLIC_*` vars are inlined by Astro from `.env`.

**A hidden record renders 404, never 403.** When a read helper returns `null` for a draft or
out-of-tier record, the page renders the generic 404 — e.g. `/meetings/[id]` — so the response
never confirms such a record exists.

**Cloudflare bindings.** `wrangler.toml` defines `DATABASE` (D1), `KV` (app KV), `SESSION` (KV for
Astro sessions, required by the adapter — the adapter enables Astro sessions against it by default
even though app auth uses Better Auth's D1 sessions rather than `Astro.session`), `DOCS` (R2
document storage), and `AI` (Workers AI / AI Search, pointed at the `AI_SEARCH_INSTANCE` var;
answer generation additionally requires the `ANTHROPIC_API_KEY` secret). The AI Search data source
is scoped to the `rag/` folder only, so it indexes the Markdown twins and never the human-readable
originals.

**Roles and access.** Roles are `visitor`, `homeowner`, `board`; content visibility tiers are
`public`, `homeowner`, `board`. Access is enforced **server-side and fail-closed**: anonymous
resolves to visitor, and unknown states resolve to the most restrictive behavior.

Production runs ADR 0022 **derived access**: a caller's capabilities and content tier are derived
per request from the party roster — Person Link, Ownerships and Representations, Board Terms, and
Access Grants. `users.role` is a **write-behind mirror, not the authority**, and is read for
authorization nowhere outside `context.ts`'s `legacy` branch (pinned by
`test/unit/authz-legacy-role.test.ts`). See
[`roster-and-access.md`](./docs/agents/roster-and-access.md).

**Every gated API namespace is gated in two places, deliberately.** `src/middleware.ts` rejects
`/api/admin/*`, `/api/member/*`, and `/api/vote` before the route runs, and **every handler
additionally opens with its own guard** (`requireBoard`, `requireMemberApi`, `requireVotingApi`).
The per-route call is the enforced and tested layer — the Workers test pool invokes handlers
directly and never runs middleware — while middleware is the production backstop for a route
shipped without its guard. **Do not remove the per-route guards in favor of the middleware**; that
would leave the behavior untested. See
[ADR 0013](./docs/adr/0013-admin-api-gated-in-middleware.md).

Three suites hold that line: `test/server/admin-routes-all-gated.test.ts` and
`test/server/member-routes-all-gated.test.ts` enumerate every route module and assert each
exported verb rejects an anonymous caller, so a new endpoint cannot ship ungated;
`test/server/permission-matrix.test.ts` asserts every route's **declared capability against every
caller class**, including a board caller who owns no Lot. Per #206 the matrix outlives the ADR
0022 migration rather than retiring at the flip.

`/api/bootstrap/board` sits outside the gated prefix on purpose — it is the fail-closed
first-System-Administrator bootstrap and must stay reachable.

**A passed preflight grants nothing.** Visibility, authority, frozen eligibility, open state,
feature flags, and duplicate exclusion are all re-checked inside the mutation SQL, so a race
returns `409` rather than a partial write. A successful member call is scoped again through the
caller's own lots (and active roster rows where identity matters), so the homeowner role alone
never grants access to an arbitrary lot.

**Role changes are direct D1 writes (`legacy`) or Access Grant writes (`derived`), never Better
Auth admin API calls.** The Better Auth admin plugin's impersonation, ban, and set-role endpoints
are **not** granted to board sessions; see `src/server/auth/permissions.ts`. A board admin cannot
escalate their own access beyond `board`.

**The write freeze is deny-by-default.** `freezePolicyFor(path)` freezes every mutation unless the
path is one of two named exemptions, so a route added tomorrow is covered before anyone thinks
about it. When adding a route you must remember its auth guard; you do not have to remember the
freeze.

**Schema changes go through hand-authored Drizzle migrations, and deploys do not apply them.**
See [`migrations.md`](./docs/agents/migrations.md) before writing or applying one.

### Glossary — "board" names three separate things

They are deliberately distinct; conflating them in code or copy is the mistake this table exists
to prevent. Use these words in that sense.

| Term              | Is                                                                     | Lives in                                                                                                  | Has history?                                                                                   |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **board admin**   | An access level. Grants admin writes _and_ the top content tier.       | `access_grants` (a live `board` or `system_admin` grant); `user.role` is now only its write-behind mirror | The grant has an interval, so ending one is recorded; the mirror column is current-state only. |
| **board member**  | A person who serves on the board.                                      | `board_service_terms` (the legacy `board_people` shape is retired for new writes)                         | Yes — the record is the point.                                                                 |
| **office / term** | One period of service, optionally with a title (President, Treasurer). | `board_service_terms` + `board_office_assignments`                                                        | Yes — a person may hold several, with gaps.                                                    |

A board member need not be a board admin, and a board admin need not be a board member. Promoting
or demoting a site account has no effect on the service roster, and a person can be recorded there
with no site login at all. The content visibility tier `board` is a fourth use of the word and
follows the **access** sense. See
[ADR 0012](./docs/adr/0012-board-record-as-structured-rows.md) for why the record is independent of
`user` rows, and [`roster-and-access.md`](./docs/agents/roster-and-access.md) for how access is
granted today.

## Testing Guidelines

Add or update tests alongside behavior changes. Test names should describe visible behavior, for
example `shows an empty state`. Prefer small focused tests over broad snapshots unless the UI is
intentionally static.

- **`npm test`** uses `vitest.config.ts` and covers `test/unit/**` plus component `*.test.tsx`.
- **`npm run test:server`** uses `@cloudflare/vitest-pool-workers` with `vitest.workers.config.ts`
  for `test/server/**`; these import `{ env, applyD1Migrations }` from `cloudflare:test` and
  mostly invoke handlers directly.

This split matches the type-checking split above: `test/unit/**` is checked by
`tsconfig.node.json`, while `test/server/**` — which imports `cloudflare:test` — stays in
`tsconfig.json`.

Pool 0.21 takes Miniflare's config-based `WorkerOptions` through `cloudflareTest({ miniflare: … })`;
supported overrides there merge over `wrangler.test.toml`.

Keep `vitest.workers.config.ts`'s `es-module-lexer` alias and its Astro Vite plugin graph: it
merges Astro's plugins into the Workers test pool, so `.astro` pages can be rendered directly
through the Astro Container API inside the real Workers runtime (see
`test/server/meeting-pages.test.ts`). A shared `isCloudflarePlugin` predicate in `vitest.shared.ts`
identifies Astro's Cloudflare adapter plugin for both configs — `vitest.config.ts` strips it as
incompatible with jsdom/node, `vitest.workers.config.ts` strips it in favor of `cloudflareTest`'s
own — so the two configs cannot drift on what counts as "a Cloudflare plugin".

`src/worker.ts` cannot be imported by the Workers test pool: it imports Astro's Cloudflare handler,
which resolves a build-time virtual module. That is why the cron body lives in
`src/server/scheduled.ts` — `test/unit/scheduled.test.ts` exercises `runScheduledJobs` directly,
and `test/unit/worker.test.ts` only asserts that `src/worker.ts` delegates to it.

## Deploy

```bash
npm run build
npm run deploy:check
npx wrangler deploy -c dist/server/wrangler.json
```

The root `wrangler.toml` uses `main = "src/worker.ts"` so the Worker exposes both Astro SSR
handling and the daily `0 7 * * *` scheduled trigger. `src/worker.ts` is a thin adapter: `fetch`
delegates to Astro's `handle`, `scheduled` delegates to `runScheduledJobs(env)`, which runs the
verification-state retention sweep, the 90-day saved-report-content sweep, and the ADR 0022
invariant drift check **independently**, so one failure cannot hide or stop the other jobs, and
throws if any failed so a partial-success invocation still shows red in the dashboard.

Deploys from `main` are handled by Cloudflare Workers Builds. Manual deploys use the
adapter-emitted `dist/server/wrangler.json`. **Deploys never apply D1 migrations.**

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, often lowercase, such as
`fix forgot password reset flow`. Keep commit subjects concise and action-oriented. PRs should
include a clear description, link related issues when applicable, and mention the commands run
locally. If a change affects UI or admin workflows, include screenshots or a short note describing
the user-visible result.

## Security & Configuration Tips

Do not commit real roster data, secrets, or production credentials. Keep environment examples in
`.env.example` and `.dev.vars.example`. Schema changes go through Drizzle migrations, and access
control must stay server-side and fail closed.

Do not commit implementation scratchpads, security reviews, import artifacts,
resident-data-derived files, or detailed operational runbooks. Durable private text (runbooks,
design history, handoffs, incident notes, 1Password secret-reference templates) lives in the
separate private companion repository that `npm run bootstrap:private` clones into the gitignored
`private/`; its locator is read from 1Password at run time and is never committed here.
Resident-derived records and generated import artifacts also live under `private/` (the default
`ASHEBROOK_PRIVATE_ROOT`, see [`docs/workstation-bootstrap.md`](./docs/workstation-bootstrap.md))
but are excluded from the companion by its own `.gitignore` and must never be committed there.

Public docs should describe supported architecture and workflows, not exploit analysis, private
execution notes, or resident-data handling details. `SECURITY.md` holds the security model,
including the AI pseudonymization guarantees and their limits.

## Agents & Docs Automation

Project subagents live in `.claude/agents/`: **`docs-updater`** keeps `AGENTS.md`, `docs/agents/`,
`README.md`, `SETUP.md`, `SECURITY.md`, and `CHANGELOG.md` in sync with the code;
**`code-reviewer`** reviews diffs against tier-enforcement, two-layer API gating, transition-only
fields, ballot secrecy, numeric-coercion, D1 write-integrity, and Drizzle FK-trap rules before
merging.

**One source of truth, two CLIs.** `.agents/skills` is the authored source for complete skill
directories. Run `npm run format` before `npm run sync:agents`; the latter regenerates
`.claude/skills` for Claude Code and `.codex/agents` from authored `.claude/agents`. Never edit
generated trees or reintroduce skill symlinks: with `core.symlinks=false`, Git stages linked
contents as duplicate files. Each authored Claude custom agent is rendered as a Codex custom-agent
TOML file, preserving its name, description, and developer instructions. The `PostToolUse` hook in
`.claude/settings.json` re-syncs after authored inputs change, and CI plus `/ship` run
`npm run sync:agents -- --check` to reject generated-tree drift. See
[ADR 0021](./docs/adr/0021-authored-agent-skills-generate-tool-specific-trees.md).

The user-invokable **`ship`** skill takes a branch from code-complete to an open PR: it classifies
the complete branch diff as a major, minor, or build release, applies any major/minor
package-version change idempotently, invokes `docs-updater` scoped to that branch's diff, writes
the `CHANGELOG.md` section for the version `scripts/next-version.sh` predicts, runs the fast
`sync:agents -- --check` / `format:check` / `lint` / `lint:coercions` / `check` gates, then pushes
and opens or updates the PR. Documentation is kept in sync at ship time through that
`docs-updater` pass, so there is no per-turn docs hook.

The user-invokable **`end-session`** skill closes out a work session across the four stores that
live outside the tracked tree and therefore rot silently: project memory, GitHub issues, the
private companion repository and `private/`, and the local workspace. It is a maintainer routine,
not a build step: it never pushes, merges, or opens PRs (that is `/ship`), never rewrites the docs
`docs-updater` owns, never runs a remote-D1 write, and shows every deletion as a list before
acting.
