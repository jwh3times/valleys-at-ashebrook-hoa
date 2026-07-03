# Implementation Plan — Outstanding Roadmap Items

**Date:** 2026-07-03
**Branch:** `claude/roadmap-implementation-plans-o9740c`
**Repo:** `jwh3times/valleys-at-ashebrook-hoa` (Astro SSR on Cloudflare Workers; D1/Drizzle, R2, KV; Better Auth)

**Sources used (no GitHub issues exist; these are the roadmap of record):**

- `docs/superpowers/plans/2026-07-03-p0-security-hardening.md` + `docs/superpowers/specs/2026-07-03-p0-security-hardening-design.md` — verified task-by-task against code and `git log` (see §1).
- Deferred / out-of-scope / follow-up sections of every other plan+spec pair under `docs/superpowers/{plans,specs}/`: document-library (2026-06-30), identity-and-roles (2026-06-30), resident-rebrand-official-mode (2026-07-01), people-per-home-roster (2026-07-02), roster-admin-ui (2026-07-02).
- `SETUP.md` / `README.md` operational steps that imply engineering work; `grep -rn "TODO|FIXME|XXX|HACK" src/ scripts/` (no actionable hits — the only match is a doc comment in `scripts/import-roster.ts:31`).
- `CHANGELOG.md` `[Unreleased]` (to avoid re-planning shipped work).

**Caveat:** the P0 spec derives from `private/improvements.md` (findings #1–21), and `private/` is gitignored and **absent in this checkout**. Findings #1–6 (P0) are fully covered by the spec; of P1–P3 (#7–21), only the findings the spec names in its Non-goals are plannable here: #7 (CI runs `test:server`), #8 (DB constraints/indexes), #9 (broad input validation), #10 (`locals.authContext` plumbing), #11 (payload trimming), #14 (Turnstile widget reset). The rest of #12–21 cannot be enumerated from this repo — see Open Questions (§5).

---

## 1. Verified status

### 1.1 P0 security hardening (plan dated 2026-07-03) — task-by-task

The plan's four PR groups all **merged to `main`** via PR #28 (`c842fc9 Merge pull request #28 from jwh3times/feat/p0-security-hardening`). Every task verified in code:

| Task | Finding | Status | Evidence (code + commit) |
| --- | --- | --- | --- |
| A1 — HMAC-keyed, constant-time OTP hashes | #4 | **Done** | `src/server/verification/codes.ts` (`hashCode(code, secret)` HMAC-SHA-256, `timingSafeEqualHex`); secret threaded in `src/server/verification/property.ts`; `test/unit/codes.test.ts`. Commit `2ae44b1`. |
| A2 — Validate settings on write, normalize dues on read | #6 | **Done** | `normalizeDuesSettings` at `src/lib/types.ts:95`; wired in `src/pages/api/admin/dues.ts:13`, `src/pages/api/admin/site.ts:13` (`normalizeSiteSettings`), `src/pages/api/content/dues.ts:20`; tests `test/unit/dues-normalize.test.ts`, `test/server/content-dues-normalize.test.ts`. Commit `5d6f1aa`. |
| A3 — Baseline security headers on every response | #3 | **Done** (CSP still Report-Only — see item 3.1) | `applySecurityHeaders` in `src/middleware.ts:27-35` (nosniff, XFO DENY, Referrer-Policy, Permissions-Policy, `Content-Security-Policy-Report-Only`); HSTS note in `SETUP.md:219-226`; `test/server/middleware-headers.test.ts`. Commit `5c1fab1`. |
| B1 — KV rate-limit primitives | #1 | **Done** | `src/server/verification/rate-limit.ts` (cooldown 120 s, `DAILY_LIMIT = 5` per user and per property); `test/server/rate-limit.test.ts`. Commit `ea04cb9`. |
| B2 — Enforce limits on `/api/verify/request` | #1 | **Done** | `src/pages/api/verify/request.ts` (pre-check + `setCooldown` + 429 JSON); per-property check inside `src/server/verification/property.ts`; `test/server/verify-request-ratelimit.test.ts`. Commit `87cb69d`. |
| B3 — Surface the 429 in the verify form | #1 | **Done** | `src/components/react/AuthForms.tsx` handles `rateLimited`/429; `test/unit/verify-form-ratelimit.test.tsx`. Commit `58e234c`. |
| C1 — Upload extension allowlist + canonical content type | #2 | **Done** | `EXT_TO_TYPE` + 415 in `src/pages/api/admin/documents.ts:16-43`; `test/server/admin-documents-board.test.ts`. Commits `37a21ef`, plus `274e896` (upload UI widened to the allowlisted types). |
| C2 — nosniff + attachment for non-PDF downloads | #2 | **Done** | `src/pages/api/files/[id].ts:31-38` (nosniff; `inline` only for `application/pdf`; sanitized filename); `test/server/files-download-safety.test.ts`. Commit `1024a21`. |
| D1 — `roles.ts` → direct-DB promote/demote + board list | #5 | **Done** | `src/pages/api/admin/roles.ts` (GET board list; POST promote-by-email / demote with last-member 409); `test/server/admin-roles-board.test.ts`. Commit `7daed58`. |
| D2 — `members.ts` revoke → direct DB + refuse board demotion | #5 | **Done** | `src/pages/api/admin/members.ts:57-64` (409 "use Board members"; direct write to `visitor`); `test/server/admin-members-revoke.test.ts`. Commit `1ce4440`. |
| D3 — Close impersonation/ban for board sessions | #5 | **Done** | `src/server/auth/permissions.ts` (admin-plugin statements intentionally not granted; comment at lines 17-19); endpoint-level 403 proven in `test/server/admin-surface-closed.test.ts:79-106`. Commits `cb9c5e5`, `78ab824`. |
| D4 — Board-members admin UI | #5 | **Done** | `src/components/admin/BoardMembersManager.tsx` + `BoardMembersManager.test.tsx`, wired into `AdminApp.tsx`. Commit `ab1a567`. |
| D5 — Align the docs | #5 | **Done** (one gap: CHANGELOG — see item 3.6) | CLAUDE.md/README describe the board-handoff workflow and closed admin surface. Commit `32f8983`. |

**Explicit follow-ups the P0 spec left open (these are the outstanding P0-adjacent work):**

| Follow-up | Status | Evidence |
| --- | --- | --- |
| Flip CSP from Report-Only to enforced (spec "Rollout"; `SETUP.md:225-227`) | **Outstanding** | `src/middleware.ts:35` still sets `Content-Security-Policy-Report-Only`. |
| Finding #7 — `test:server` in CI | **Done** (landed after the spec) | `.github/workflows/build.yml:34` runs `npm run test:server`; commit `3adad10`. |
| Finding #14 — Turnstile widget reset on spent token | **Outstanding** | `src/components/react/AuthForms.tsx:104-105` reads `window.turnstileToken` once; no reset after a failed/rate-limited submit. |
| Finding #10 — use `locals.authContext` instead of re-fetching | **Outstanding** | `src/middleware.ts:40` sets `context.locals.authContext`, but no API route reads it: `getAuthContext(request, env)` is re-called in `src/pages/api/{content/announcements,content/documents,files/[id],verify/request,verify/confirm,admin/roles}.ts` and inside `requireBoard` (`src/server/authz/api-guards.ts`) used by every admin route — two session/DB lookups per request. |
| Finding #8 — DB constraints/indexes | **Outstanding** | `src/server/db/schema.ts` has only primary keys (grep for `unique|index` matches nothing beyond PKs); e.g. no unique on `properties.addressNormalized`, no index on `owners.propertyId`, `user_property_links(userId)`, `property_verifications(userId)`, `documents(visibility)`. |
| Findings #9/#11 — broad input validation / payload trimming | **Outstanding** | Admin writes besides site/dues parse request JSON with type assertions and persist coerced-but-unvalidated strings (e.g. `src/pages/api/admin/announcements.ts`, `properties.ts`, `owners.ts`); no length caps. |
| Spec appendix — Google Docs/Sheets/Drive import | **Outstanding (backlog by design)** | Not implemented anywhere; explicitly deferred as a future stretch goal (`2026-07-03-p0-security-hardening-design.md` §PR C appendix). |

### 1.2 Deferred items from the other five plan/spec pairs

| Item | Source | Status |
| --- | --- | --- |
| Roster admin UI (Properties→owners editor) | people-per-home-roster plan "Out of scope (follow-up)" | **Done** — shipped by the roster-admin-ui plan (`src/components/admin/RosterManager.tsx`, `MembersManager.tsx`; commits `24ebce0`, `0dd0ca7`). |
| SMS provider selection (Twilio assumed) | identity-and-roles spec §13 | **Done** — Twilio wired in `src/server/auth/` senders; `TWILIO_*` in `src/env.d.ts`. |
| Firebase/Firestore removal | identity-and-roles plan | **Done** — no `firebase` references remain in `src/`; `d131559` removed the last leftover. |
| Admin-managed disclaimer / About copy + admin overview | resident-rebrand spec §11 | **Outstanding** — disclaimer/About copy hardcoded in `src/lib/site.ts` (lines 9, 14); `SiteSettings` (`src/lib/types.ts:37-45`) has no such fields. |
| Cloudflare D1/R2 resource rename; GitHub repo rename | resident-rebrand spec §11 | **Outstanding — deliberately deferred, operational** (migration risk; maintainer dashboard/GitHub actions, not code). `wrangler.toml` still binds `ashebrook-hoa` / `ashebrook-hoa-docs`. |
| Revisit officialMode flag storage if settings grow | resident-rebrand spec §11 | **Not triggered** — settings blob still small; fold into item 3.5 if it lands. |
| Ownership-transfer workflow beyond deactivate/add; `Account #` capture; tenant modeling | people-per-home-roster plan/spec non-goals | **Outstanding (backlog)** — roster UI supports only status PATCH (`roster-admin-ui` spec non-goals honored). |
| Bulk roster import UI (CLI remains the bulk path) | roster-admin-ui spec non-goals | **Outstanding (backlog)** — `npm run roster:import` CLI only (`scripts/import-roster.ts`). |
| Per-owner private data (dues balances, violations) tables + UI | document-library spec §2/§13; identity-and-roles spec §13/§14 | **Outstanding (backlog)** — no such tables in `src/server/db/schema.ts`. |
| Homeowner-facing uploads; signed-PUT for large files | document-library spec non-goals, §8 | **Outstanding (backlog, low priority)** — board-only upload with 25 MB cap in `src/pages/api/admin/documents.ts`. |
| OCR / embeddings / vector search / AI assistant ("sub-project C") | document-library + identity-and-roles specs | **Outstanding (far backlog)** — never specced; requires its own design round. |
| Tenants/renters accounts; online payments | identity-and-roles spec §13/§14 | **Outstanding (backlog, board-decision-gated)**. |

### 1.3 Operational steps implying engineering work (SETUP.md / README.md)

| Item | Source | Status |
| --- | --- | --- |
| First-board bootstrap requires hand-writing a **temporary Worker route**, deploying, POSTing, then deleting it and redeploying | `SETUP.md:126-155` (§6) | **Outstanding** — `scripts/seed-board.ts` exists but has no safe invocation path; the documented procedure is error-prone (a forgotten route is a privileged backdoor). Plan: item 3.4. |
| Roster import: CLI → SQL file → `wrangler d1 execute` | `SETUP.md:112-122` (§5) | Works as designed; UI bulk import is backlog (§4.3). |
| Docs import: dry-run manifest → `--commit` | `SETUP.md:160-168` (§7) | Works as designed; no engineering gap. |
| HSTS zone toggle + CSP report watching | `SETUP.md:219-227` | HSTS = dashboard action (operator). CSP flip = code change: item 3.1. |

### 1.4 CHANGELOG check

`CHANGELOG.md` `[Unreleased]` covers the six shipped feature waves but has **no entries for the P0 security hardening or the board-handoff workflow** (both merged). That is docs drift, planned as item 3.6.

---

## 2. Sequencing & priority

Security-adjacent work first (finishing the P0 program), then correctness/robustness (P1-shaped), then product backlog. Each numbered item is one small PR off `main`; all are independent unless noted.

| Order | Item | Priority | Size |
| --- | --- | --- | --- |
| 1 | 3.1 Flip CSP to enforce mode | P0 follow-up | S |
| 2 | 3.6 CHANGELOG + SECURITY.md sync for the shipped P0 work | P0 follow-up (docs) | S |
| 3 | 3.2 Turnstile widget reset on failed/rate-limited verify (#14) | P1 | S |
| 4 | 3.3 `locals.authContext` plumbing — one auth read per request (#10) | P1 | S–M |
| 5 | 3.7 D1 constraints & indexes (#8) | P1 | M |
| 6 | 3.8 Input validation + payload trimming on admin writes (#9, #11) | P1 | M |
| 7 | 3.4 Seed-board bootstrap hardening (retire the temp-route procedure) | P1 (ops safety) | M |
| 8 | 3.5 Admin-managed disclaimer / About copy | P2 | M |
| 9+ | §4 Backlog: Google Drive import, per-owner data, bulk roster UI, tenants/payments, AI assistant | P3 / gated | M–XL |

Rationale for the top slots: item 3.1 is the only unfinished step of the P0 rollout plan itself ("the CSP flips from Report-Only to enforced in a small follow-up"); 3.2–3.8 are the P1 findings that are already named and verifiable from this repo. Everything in §4 needs either a board decision or its own design spec before build.

---

## 3. Detailed plans

### 3.1 Flip the Content-Security-Policy from Report-Only to enforced

**Objective & rationale.** Complete the last step of P0 finding #3. A Report-Only CSP observes but does not block; until the header is enforced, inline-script injection and frame-based attacks are only logged by the browser, not stopped. The P0 spec's Rollout section explicitly schedules this flip "once report-only telemetry (or manual verification) confirms no legitimate resource is blocked."

**Current state.** `src/middleware.ts:14-25` builds the `CSP` directive list (self + Turnstile script, Google Fonts, Google Calendar + Turnstile frames, Web3Forms connect, `frame-ancestors 'none'`); `src/middleware.ts:35` sets it as `Content-Security-Policy-Report-Only`. `test/server/middleware-headers.test.ts` asserts the Report-Only header. `SETUP.md:225-227` documents the flip as pending.

**Design / approach.**

- Verification first (this is the actual work): run the site locally (`npm run dev`) and click through every page/island — home, announcements, documents (+ a PDF inline view via `/api/files/[id]`), calendar embed, dues, about, login, signup + Turnstile, verify flow, contact form (Web3Forms), `/admin` all sections — watching the console for CSP violation reports. On the deployed site, watch for violations for a few days of normal board/homeowner use.
- Then rename the header key in one place. **Decision:** keep the exact same directive string; do not add a `report-uri`/`report-to` endpoint (rejected: Workers-side report ingestion is extra surface for negligible value on a site this size; browser console + the verification pass suffice). **Decision:** keep `'unsafe-inline'` in `script-src`/`style-src` as shipped — Astro island hydration and injected styles require it on this stack; nonce-based CSP on Astro SSR is a larger project and out of scope (rejected for now, note as future tightening).
- Optional belt-and-braces: keep sending Report-Only alongside the enforced header for one deploy (both headers may coexist) — **rejected** as unnecessary complexity; a single enforced header plus a fast rollback (one-line revert) is simpler.

**Step-by-step tasks.**

1. `src/middleware.ts` — change `headers.set('Content-Security-Policy-Report-Only', CSP)` to `headers.set('Content-Security-Policy', CSP)`; update the explanatory comment at lines 12-13.
2. `test/server/middleware-headers.test.ts` — update the assertion from `content-security-policy-report-only` to `content-security-policy` (keep the `calendar.google.com` containment check).
3. `SETUP.md` §Security headers — rewrite the "flip it later" paragraph to state the CSP is enforced and how to temporarily revert if a new third-party resource is added.
4. Run the full gate; commit `feat(security): enforce the Content-Security-Policy (#3 follow-up)`.

**Testing plan.** `npx vitest run --config vitest.workers.config.ts test/server/middleware-headers.test.ts test/server/middleware.test.ts test/server/middleware-site.test.ts`; then `npm run format:check && npm run check && npm test && npm run test:server && npm run build`. Manual dev-server click-through (above) is a required pre-merge step, recorded in the PR description.

**Docs updates.** `SETUP.md` (step 3 above); `CHANGELOG.md` `[Unreleased]` → `### Security` bullet. CLAUDE.md/README need no change (they don't mention CSP mode).

**Risks & open questions.** Risk: a directive misses a legitimate resource and something breaks visibly in production — mitigated by the verification pass and one-line rollback. Open question: whether the operator has already watched production console output since PR A deployed; if not, budget a few days of Report-Only observation before merging.

**Size: S** (one-line code change; the effort is verification).

---

### 3.2 Reset the Turnstile widget after a failed / rate-limited verify request (#14)

**Objective & rationale.** Turnstile tokens are single-use. After a 429 (rate-limit) or 400 response from `/api/verify/request`, the form retains the spent token in `window.turnstileToken`; the user's retry then fails Turnstile validation ("Bad captcha") with no way to recover except reloading the page. Fixing this completes the UX edge the P0 spec explicitly noted and deferred ("Widget-reset on spent Turnstile is finding #14, P2 — out of scope, noted").

**Current state.** `src/components/react/AuthForms.tsx:104-105` reads `(window as ... ).turnstileToken` set by the Turnstile widget callback rendered on the page. There is no call to `window.turnstile.reset()` anywhere in `src/` (grep confirms). The server consumes the token in `src/server/authz/turnstile.ts` via Cloudflare's siteverify.

**Design / approach.**

- After every `request()` submission — success or failure — call the Turnstile client API to reset the widget so a fresh token is issued: `window.turnstile?.reset()` (the global is present when the widget script has loaded; optional-chain so tests/jsdom don't crash), and clear `window.turnstileToken`.
- **Decision:** reset unconditionally after submit rather than only on error — a success moves the UI to the confirm stage, so the reset is harmless, and it removes a state branch. **Rejected alternative:** managing the token in React state via an explicit render callback ref — more idiomatic but a larger refactor of how the widget is mounted in the Astro page; not warranted for this fix.
- Type the global once: extend the existing inline `window` casts into a small local declaration (`declare global { interface Window { turnstileToken?: string; turnstile?: { reset: () => void } } }`) in `AuthForms.tsx` (or a `src/lib/turnstile.d.ts`), removing the repeated `as unknown as` casts.

**Step-by-step tasks.**

1. `src/components/react/AuthForms.tsx` — in `VerifyPropertyForm.request`, wrap the fetch/response handling in `finally { window.turnstile?.reset(); window.turnstileToken = undefined; }`; add the global type declaration.
2. `test/unit/verify-form-ratelimit.test.tsx` — extend: stub `window.turnstile = { reset: vi.fn() }`, assert `reset` is called after the 429 path; add one case asserting reset after a successful send.
3. Gate + commit `fix(verification): reset the Turnstile widget after each verify request (#14)`.

**Testing plan.** `npx vitest run test/unit/verify-form-ratelimit.test.tsx` plus the full jsdom suite (`npm test`); `npm run check`; `npm run format:check`. No server-tier change. Manual check in `npm run dev`: submit, get rate-limited, resubmit → new token, no "Bad captcha".

**Docs updates.** `CHANGELOG.md` `[Unreleased]` → `### Fixed`. No CLAUDE/README/SETUP change (behavioral detail below their altitude).

**Risks & open questions.** Minimal; `turnstile.reset()` on an unmounted/absent widget is guarded by optional chaining. Open question: whether other Turnstile-gated forms (signup) share the same spent-token bug — inspect `AuthForms.tsx` siblings while in the file and apply the same `finally` if so.

**Size: S**.

---

### 3.3 Use `locals.authContext` in API routes — one auth read per request (#10)

**Objective & rationale.** The middleware already resolves the caller (`src/middleware.ts:40` sets `context.locals.authContext`), but every API route re-runs `getAuthContext(request, env)` — a second Better Auth session lookup + D1 user read per request. Plumbing the middleware's result through halves auth-path DB round-trips, removes a class of drift (two call sites deciding the caller), and keeps fail-closed semantics in exactly one place.

**Current state.**

- `src/env.d.ts:26-31` — `App.Locals` already declares `authContext: AuthContext | null` and `site: SiteSettings`.
- Direct re-fetch call sites: `src/pages/api/content/announcements.ts`, `src/pages/api/content/documents.ts`, `src/pages/api/files/[id].ts`, `src/pages/api/verify/request.ts`, `src/pages/api/verify/confirm.ts`, `src/pages/api/admin/roles.ts`.
- Indirect: every `/api/admin/*` route calls `requireBoard(request, env)` (`src/server/authz/api-guards.ts:5-19`), which internally calls `getAuthContext` again.
- Server tests mock `getAuthContext` at module level (e.g. `test/server/admin-roles-board.test.ts`, `verify-request-ratelimit.test.ts`) and invoke handlers with `{} as never` / `{ request } as never` — i.e. **without** `locals`.

**Design / approach.**

- Change route handlers to read `locals.authContext` from the `APIContext` argument, with a **fail-closed fallback**: `const ctx = locals?.authContext ?? (await getAuthContext(request, env));` — **Decision:** keep the fallback rather than trusting `locals` unconditionally, because the Worker-pool tests call handlers directly without running the middleware, and a missing `locals` must never resolve to a privileged context. `?? null`-only (no fallback fetch) was **rejected**: it would silently 401 every direct-invocation test and force rewriting all test harnesses at once.
- Rework `requireBoard` to accept the context instead of re-fetching: new signature `requireBoard(locals: App.Locals | undefined, request: Request, env: Env)` — or simpler, split into `resolveAuthContext(locals, request, env)` (the fallback logic, one place) + existing `requireRole`. All `/api/admin/*` routes switch to `const denied = await requireBoard(locals, request, env)`.
- Because the fallback preserves current behavior when `locals` is absent, existing module-level `vi.mock('.../authz/context')` test seams keep working unchanged.

**Step-by-step tasks.**

1. Add `resolveAuthContext(locals, request, env)` to `src/server/authz/api-guards.ts`; refactor `requireBoard` to use it and take `locals` as its first parameter.
2. Update all `/api/admin/*` routes (`documents.ts`, `announcements.ts`, `dues.ts`, `site.ts`, `properties.ts`, `owners.ts`, `members.ts`, `roles.ts`) to pass `locals` through.
3. Update the six direct call sites listed above to `resolveAuthContext(locals, request, env)`.
4. Add one server test (`test/server/authz-locals.test.ts`): (a) a handler invoked with `locals.authContext` set to a board context and a *failing* `getAuthContext` mock succeeds without a second lookup; (b) invoked with no `locals` falls back and stays fail-closed for anonymous.
5. Gate + commit `refactor(authz): resolve the caller once via locals.authContext (#10)`.

**Testing plan.** Full `npm run test:server` (all `test/server/**` exercise these routes) + `npm test` + `npm run check` + `npm run format:check` + `npm run build`. Watch specifically `admin-*-board`, `files-authz`, `content-reads-authz`, `middleware*` suites for behavior drift — expected zero.

**Docs updates.** CLAUDE.md "Server code" sentence for `authz/` gains `resolveAuthContext`; `CHANGELOG.md` `### Changed`. No README/SETUP impact.

**Risks & open questions.** Risk: a route that runs before middleware (none exist — Astro middleware wraps all routes) or a subtle test relying on double-fetch counts. Open question: whether `verify/confirm.ts` needs the *freshest* role mid-flow (it promotes the user) — it reads the context only to identify the caller, so the middleware-resolved value is fine.

**Size: S–M** (mechanical, ~10 files, one new test file).

---

### 3.4 Seed-board bootstrap hardening — retire the temporary-route procedure

**Objective & rationale.** `SETUP.md` §6 (lines 126-155) instructs the operator to hand-write a temporary privileged Worker route calling `seedBoard`, deploy it, POST once with a shared secret header, then delete the route and redeploy. This is the riskiest documented procedure in the project: a forgotten route is a standing role-escalation backdoor, and hand-pasted code drifts. Replace it with a built-in, fail-closed bootstrap that is inert once any board account exists.

**Current state.** `scripts/seed-board.ts` exports `seedBoard(env, email, password, name)` (direct `role`/`emailVerified` DB writes via Better Auth signup + Drizzle). No route imports it (grep: only SETUP.md references it). First-board bootstrap is otherwise impossible in-app — by design, `board` is only grantable by an existing board member (`src/pages/api/admin/roles.ts`).

**Design / approach.**

- New permanent endpoint `src/pages/api/bootstrap/board.ts` (`POST`), fail-closed on **three independent conditions**, all required:
  1. **Self-disabling:** `SELECT count(*) FROM user WHERE role='board'` — if ≥ 1, return `410 Gone` before reading anything else. This is the primary guard: the endpoint is permanently inert on any bootstrapped site.
  2. **Secret:** constant-time compare of the `x-bootstrap-secret` header against `env.BOOTSTRAP_SECRET` (reuse `timingSafeEqualHex`-style comparison from `src/server/verification/codes.ts`, generalized into `src/server/authz/` if needed); missing secret binding → `403` (never "unset means open").
  3. **Config:** `BOARD_EMAIL`/`BOARD_PASSWORD`/`BOARD_NAME` read from env secrets (as SETUP.md already prescribes) → `400` if missing.
- On success: call `seedBoard`, return `204`. Add `BOOTSTRAP_SECRET`, `BOARD_EMAIL`, `BOARD_PASSWORD`, `BOARD_NAME` as optional members of `Cloudflare.Env` in `src/env.d.ts`.
- **Decision — permanent guarded route over the temp-route runbook:** the count(=0) guard makes "remove the route" unnecessary; the failure mode flips from "operator forgets to delete a backdoor" to "endpoint refuses because a board exists," which is fail-safe. **Rejected alternatives:** (a) `wrangler d1 execute` a hand-built SQL insert — Better Auth password hashing makes raw SQL fragile; (b) a wrangler-invoked local script against remote D1 — the password hash must be produced by the same Better Auth version/config as the Worker, which the in-Worker route guarantees; (c) keeping the SETUP.md temp-route as-is — the status quo this item exists to remove.
- Move `seedBoard`'s implementation under `src/server/auth/seed-board.ts` and have `scripts/seed-board.ts` re-export (route code importing from `scripts/` is a layering smell); keep the script entry for any existing operator muscle memory.

**Step-by-step tasks.**

1. Relocate logic to `src/server/auth/seed-board.ts`; re-export from `scripts/seed-board.ts`.
2. Create `src/pages/api/bootstrap/board.ts` with the three-guard POST above (`export const prerender = false;` like sibling routes).
3. Extend `src/env.d.ts` with the four optional secrets.
4. Tests `test/server/bootstrap-board.test.ts` (vitest-pool-workers + `applyD1Migrations`): 410 when a board user exists; 403 on wrong/missing secret (with no board user); 400 on missing BOARD_* config; 204 happy path creates a `board` user with `emailVerified`; second call after success → 410. Secret provided to the test env via `vitest.workers.config.ts` bindings (mirror how `BETTER_AUTH_SECRET`/`test-secret-not-real` is injected).
5. Rewrite `SETUP.md` §6: set the four secrets, `curl -X POST https://<site>/api/bootstrap/board -H 'x-bootstrap-secret: …'`, then (recommended) delete the `BOOTSTRAP_SECRET`/`BOARD_PASSWORD` secrets. Update `README.md:112` sentence.
6. Gate + commit `feat(auth): built-in fail-closed first-board bootstrap endpoint`.

**Testing plan.** New server test file (above) + full `npm run test:server`; `npm test`; `npm run check`; `npm run format:check`; `npm run build`. Manual: local `npm run dev` + curl against a fresh local D1 (`npm run db:migrate:local`).

**Docs updates.** SETUP.md §6 rewrite; README seed-board sentence; CLAUDE.md endpoint list gains `/api/bootstrap/board`; SECURITY.md "board is never self-grantable" paragraph gains the bootstrap caveat; CHANGELOG `### Added`/`### Security`.

**Risks & open questions.** Risk: the count-guard query must run against the Better Auth `user` table (`src/server/db/auth-schema.ts`) — use the Drizzle schema object, not raw SQL, to survive schema regeneration. Open question: should the endpoint also require the site to have zero *users* of any role (stricter)? Default **no** — homeowners may legitimately register before the board bootstraps; the board-count guard is the correct predicate. Low-stakes default, stated here.

**Size: M**.

---

### 3.5 Admin-managed disclaimer / About copy (rebrand follow-up)

**Objective & rationale.** The resident-rebrand spec (§11) deferred making the unofficial-site disclaimer and the `/about` page copy board-editable. Today changing a sentence of legal-ish text requires a code deploy. Board self-service matches how every other content surface already works (announcements, dues, site settings).

**Current state.** `src/lib/site.ts` hardcodes the footer disclaimer (line 9) and the About paragraphs (line 14) as constants consumed by `.astro` pages/footer; `SiteSettings` (`src/lib/types.ts:37-45`) has `siteName`, `tagline`, `contactEmail`, `welcomeHeading`, `welcomeBody`, `officialMode`. Site settings persist as the `site` key in the `settings` table (`src/server/db/schema.ts:93`) via `PUT /api/admin/site` → normalized by `normalizeSiteSettings` (`src/lib/types.ts:60-81`), read by middleware for page renders (`src/middleware.ts`, `getSiteSettings`) and by `GET /api/content/site`. Admin UI: `src/components/admin/SiteManager.tsx`.

**Design / approach.**

- Extend `SiteSettings` with `disclaimerText: string` and `aboutBody: string` (plain text, blank ⇒ fall back to the current hardcoded copy so existing deployments render unchanged). Defaults added to `DEFAULT_SITE_SETTINGS`; `normalizeSiteSettings` coerces both with the existing `str()` helper. **No D1 migration** — settings are a JSON blob in an existing row; normalization gives old blobs the defaults (this is exactly the pattern `officialMode` used, and satisfies the spec's "revisit the flag storage" note: still not needed at this size).
- `src/lib/site.ts` keeps the constants as fallbacks and gains pure helpers that take the settings, e.g. `disclaimer(site: SiteSettings): string` returning `site.disclaimerText || FALLBACK` — pure-module contract preserved (usable in `.astro`, islands, unit tests).
- UI: two textareas in `SiteManager.tsx` (hidden/disabled note when `officialMode` is on for the disclaimer, since official mode suppresses it). Writes go through the existing `PUT /api/admin/site` (board-only via `requireBoard`; no new endpoint, no new authz surface).
- **Rejected alternatives:** dedicated `settings` keys per copy block (more rows, more reads, no benefit at this size); markdown rendering (XSS surface for no current need — plain text with line breaks, matching announcements).

**Step-by-step tasks.**

1. `src/lib/types.ts` — extend `SiteSettings`, `DEFAULT_SITE_SETTINGS`, `normalizeSiteSettings`.
2. `src/lib/site.ts` — settings-aware helpers with hardcoded fallbacks; update the footer/About `.astro` consumers (`src/pages/about.astro`, footer layout component) to pass `Astro.locals.site` through.
3. `src/components/admin/SiteManager.tsx` — add the two fields.
4. Tests: extend `test/unit/site.test.ts` (fallback + override paths for the helpers), `test/unit/SiteManager.test.tsx`-equivalent (`src/components/admin/SiteManager.test.tsx`) for the new fields' payloads, and `test/server/site-settings.test.ts` / `admin-settings-board.test.ts` for round-tripping the new keys through the PUT→GET path.
5. Gate + commit `feat(site): board-editable disclaimer and About copy`.

**Testing plan.** `npm test` (site + SiteManager suites), `npm run test:server` (settings round-trip), `npm run check`, `npm run format:check`, `npm run build`.

**Docs updates.** CLAUDE.md `src/lib/site.ts` description (helpers now settings-aware); CHANGELOG `### Added`. README/SETUP unaffected.

**Risks & open questions.** Risk: forgetting a consumer of the old constants — grep `src/` for the constant names as a completion check. Open question (product): should About copy differ between official and unofficial mode? Default: single field, mode-independent (disclaimer already handles the mode split) — low-stakes, stated.

**Size: M**.

---

### 3.6 CHANGELOG + SECURITY.md sync for the shipped P0 work

**Objective & rationale.** The P0 hardening and board-handoff workflow are merged but invisible in `CHANGELOG.md` `[Unreleased]` (it ends at the roster/members admin UI). SECURITY.md's "Security model" also predates the hardening (no mention of rate limiting, upload/download constraints, security headers, or the closed impersonation/ban surface) and its "board is never self-grantable" phrasing should match the nuanced wording CLAUDE.md/README now carry. Keep the public record accurate before the next feature lands on top.

**Current state.** `CHANGELOG.md` `[Unreleased]` has six `### Added` bullets, none security; `SECURITY.md` "Security model" (lines 19-34) and "Automated safeguards" (lines 36-40) are pre-P0.

**Step-by-step tasks.**

1. `CHANGELOG.md` — add `### Security` bullets: verify-request rate limiting (KV cooldown + daily caps, 429 UX); document upload allowlist + canonical content type; download nosniff/attachment hardening; baseline security headers + Report-Only CSP (amend when 3.1 lands); HMAC-keyed constant-time OTP hashes; settings normalization on write/read; impersonation/ban closed to board sessions. Add `### Added`: Board members admin panel (promote/demote handoff, last-member guard).
2. `SECURITY.md` — extend the model section with the same facts at model-altitude (headers, upload/download policy, OTP storage, rate limits, closed admin-plugin surface, board handoff wording aligned with CLAUDE.md).
3. Commit `docs: record P0 security hardening in CHANGELOG and SECURITY.md`.

**Testing plan.** `npm run format:check` (Prettier covers markdown); no code gates affected.

**Docs updates.** This item *is* the docs update. **Risks:** none. **Size: S**.

---

### 3.7 D1 constraints & indexes (#8)

**Objective & rationale.** The schema has no secondary indexes or uniqueness constraints (`src/server/db/schema.ts` — PKs only), so integrity rules live only in application code and hot lookups scan. Named as P1 finding #8 by the P0 spec ("No D1 migration is required by any P0 item — constraints/indexes are #8, P1").

**Current state.** Query paths that deserve indexes/constraints (from `src/server/` reads):

- `properties.addressNormalized` — verification matching key (`src/server/verification/property.ts`, roster lookup) → should be **unique** (one home per normalized address; the import dedups on it).
- `owners.propertyId` — fan-out reads per home (`property.ts`, `GET /api/admin/properties` nesting) → index.
- `user_property_links (userId)` and (userId, propertyId) uniqueness — `getAuthContext`/guards resolve a user's homes per request → unique composite + index.
- `property_verifications (userId)` — request flow deletes prior unconsumed codes by user → index.
- `documents (visibility)`, `announcements (visibility, date)` — tier-filtered public reads → index.
- `manual_approval_queue (userId)` — members queue reads → index.

**Design / approach.** Add Drizzle `uniqueIndex`/`index` definitions in `src/server/db/schema.ts` table callbacks, then `npm run db:generate` → migration `0003_*.sql`. **Decision:** uniques only where the app already guarantees uniqueness (verify with a pre-migration data audit query in the PR description; a duplicate `addressNormalized` in prod D1 would fail the migration — check with `wrangler d1 execute ... "SELECT addressNormalized, count(*) c FROM properties GROUP BY 1 HAVING c>1"` first). **Rejected:** CHECK constraints on role/visibility enums — Drizzle-D1 support is awkward and the fail-closed readers already treat unknown values as most-restrictive, so a CHECK adds migration risk for little gain (note as possible follow-up).

**Step-by-step tasks.**

1. Schema: add the index/unique definitions above.
2. `npm run db:generate`; review the emitted `src/server/db/migrations/0003_*.sql` (should be `CREATE [UNIQUE] INDEX` statements only).
3. Server tests: `test/server/schema-constraints.test.ts` — after `applyD1Migrations`, inserting two properties with the same `addressNormalized` throws; duplicate `(userId, propertyId)` link throws; a second board user + queries still pass. (Migrations are auto-applied in the Worker pool via the `MIGRATIONS` binding, so the new file is picked up with zero harness change — `src/env.d.ts:18-19`.)
4. Run the **entire** server suite — this is the real regression net (any test seeding duplicate fixtures will surface immediately and must be fixed to respect the new constraints).
5. `SETUP.md`/README unchanged; operator runs `npm run db:migrate:remote` on deploy (already step 4 of SETUP).
6. Gate + commit `feat(db): uniqueness + hot-path indexes for roster/verification/content (#8)`.

**Testing plan.** `npm run test:server` (all files — constraint regressions), `npm test`, `npm run check`, `npm run format:check`, `npm run build`; local `npm run db:migrate:local` smoke.

**Docs updates.** CLAUDE.md data-model paragraph (mention migration `0003`); CHANGELOG `### Changed`.

**Risks & open questions.** Risk: existing production data violating a new unique (mitigation: audit query above; if duplicates exist, ship the index non-unique and clean data first). Open question: real prod data state — operator must run the audit before `db:migrate:remote`.

**Size: M**.

---

### 3.8 Input validation + payload trimming on admin writes (#9, #11)

**Objective & rationale.** Site/dues writes are normalized (P0 #6), but the other board-only writes (`announcements`, `properties`, `owners`, `documents` metadata fields) parse JSON/FormData with bare type assertions and persist whatever strings arrive — no length caps, no field allowlists, no trimming. Board-only reduces the threat, but a compromised/mistaken board session can bloat D1 rows, break rendering with megabyte strings, or store unexpected keys. This is the P1 pair (#9 validation, #11 trimming) named in the P0 spec's non-goals.

**Current state.** `src/pages/api/admin/announcements.ts` (POST/PUT bodies asserted to `Announcement`-ish shapes), `src/pages/api/admin/properties.ts` / `owners.ts` (roster CRUD from `RosterManager`), `src/pages/api/admin/documents.ts` (title/category/visibility fields from FormData; visibility already checked against `VISIBILITIES`). `src/lib/types.ts` has the normalize pattern to copy.

**Design / approach.**

- Extend the established normalizer pattern rather than adopting a validation library: per-shape `normalizeAnnouncementInput`, `normalizePropertyInput`, `normalizeOwnerInput` in `src/lib/types.ts` (shared with the client for pre-submit trimming) — coerce to string, `trim()`, enforce max lengths (title 200, body 10 000, address 300, name 200, notes 2 000, email 320, phone 32 — constants exported), validate enums (`visibility` via existing `Visibility`, owner/property `status` ∈ `active|inactive`), drop unknown keys, and **reject** (400 with a field message) rather than silently default when a *required* field is empty (title, address, fullName) — creating content is not the read path, so fail loudly. **Rejected:** zod/valibot — a new dependency and idiom for ~4 shapes when the codebase already has a tested hand-rolled pattern.
- Dates: announcements `date` must parse as ISO `YYYY-MM-DD` (regex + `Date` sanity) else 400.

**Step-by-step tasks.**

1. `src/lib/types.ts` — add the three input normalizers + length constants (unit tests first: `test/unit/input-normalize.test.ts` covering trim, cap, unknown-key drop, enum reject, required-field reject).
2. Wire into `src/pages/api/admin/announcements.ts`, `properties.ts`, `owners.ts` (and the FormData fields in `documents.ts`: trim/cap `title`, validate `category` against `DOCUMENT_CATEGORIES`).
3. Server tests: extend `test/server/admin-announcements-board.test.ts`, `admin-properties.test.ts`, `admin-owners.test.ts`, `admin-documents-board.test.ts` with: over-length body → 400; unknown key not persisted; whitespace-only required field → 400; happy path trimmed.
4. Client: `RosterManager.tsx` / `AnnouncementsManager.tsx` surface the 400 message (they already render error strings from failed fetches via `src/lib/admin.ts` — verify and extend if the helper swallows bodies).
5. Gate + commit `fix(admin): validate and trim admin write payloads (#9, #11)`.

**Testing plan.** New unit file + extended server suites; full `npm test && npm run test:server && npm run check && npm run format:check && npm run build`.

**Docs updates.** CHANGELOG `### Changed`/`### Security`; CLAUDE.md `src/lib/types.ts` bullet gains "+ input normalizers". README/SETUP unaffected.

**Risks & open questions.** Risk: an existing admin UI flow sends a field the normalizer drops (mitigated by running the jsdom manager suites, which assert exact payloads). Open question: exact caps are judgment calls — the numbers above are stated defaults; being wrong costs a one-line constant change (low-stakes).

**Size: M**.

---

## 4. Backlog (needs its own design round or a board/operator decision first)

These are recorded so they aren't lost; each should get a spec under `docs/superpowers/specs/` before build. Ordered by likely value.

### 4.1 Google Docs/Sheets/Drive import (P0 spec appendix — future stretch goal)

- **Objective:** board pastes a Drive/Docs share link; the server exports Docs→PDF and Sheets→xlsx via the Drive API and stores the result through the existing document pipeline (R2 + `documents` row), inheriting tier checks.
- **Current state:** nothing exists; the P0 spec appendix (`2026-07-03-p0-security-hardening-design.md` §PR C appendix) deliberately shaped the upload allowlist so exported artifacts (PDF/xlsx) already pass — no allowlist change will be needed.
- **Sketch:** new board-only endpoint `POST /api/admin/documents/import-drive` (`requireBoard`; body `{ url, title?, category, visibility }`); server-side Google auth via a **service account** (key as a wrangler secret) hitting `drive.files.export`; reuse the R2 write + D1 insert from `src/pages/api/admin/documents.ts` (extract a shared `storeDocument()` helper); size-cap the export stream at the same 25 MB. UI: an "Import from Google" affordance in `DocumentsManager.tsx`.
- **Key decisions to settle in its spec:** OAuth-per-board-member vs. shared service account (default: service account — no per-user consent UX, files must simply be shared to its address); export-time snapshot vs. live-sync (default: snapshot; re-import to refresh).
- **Testing:** server tests with a mocked Drive fetch (the repo's pattern of `vi.mock` on a sender module); jsdom test for the manager form; no migration.
- **Docs:** SETUP.md gains a Google service-account section; CLAUDE.md endpoint list; CHANGELOG.
- **Risks:** Google API quotas/auth complexity in a Worker (must use raw REST + a JWT-signed token, not the Node SDK). **Size: L.**

### 4.2 Per-owner private data — dues balances / violations (identity-and-roles §13, document-library §2)

Blocked on a board decision to publish per-owner data at all (privacy). Substrate exists: `owners`/`user_property_links` give the authorization join. Sketch: new D1 tables (`owner_dues`, `violations`) keyed to `owner_id`/`property_id` via Drizzle migration; homeowner-tier endpoints that filter to the caller's own `propertyIds` from `getAuthContext` (fail-closed: empty list ⇒ nothing); board CRUD in admin. Must reuse the tier model, never a client-side filter. **Size: L.**

### 4.3 Roster quality-of-life — bulk import UI, ownership transfer, Account #

Deferred by the roster plans (`2026-07-02-people-per-home-roster.md` "Out of scope"; `2026-07-02-roster-admin-ui-design.md` non-goals). Bulk import UI would wrap the `scripts/import-roster.ts` parse in a board-only upload endpoint (spreadsheet → preview diff → commit); ownership transfer is a one-click "deactivate old owner + add new" compound action on `RosterManager`; `Account #` is a nullable `owners` column + form field (needs migration). All board-only, standard `requireBoard` + tests pattern. **Size: M** (each).

### 4.4 Homeowner uploads / signed-PUT large files (document-library non-goals, §8)

No current demand; board manages all content. Revisit only if the 25 MB Worker-body cap in `src/pages/api/admin/documents.ts` bites — then an R2 presigned-PUT flow. **Size: M, dormant.**

### 4.5 Tenants/renters accounts; online payments; OCR/AI assistant (identity-and-roles §13/§14; document-library §13)

All explicitly gated: tenants on a board request (owner-delegated invite model), payments on the board adopting the site officially (official mode exists to stage this), the AI assistant ("sub-project C") on a dedicated spec. Record-only here. **Size: L–XL each.**

### 4.6 Operational (not code)

- **HSTS** — Cloudflare zone dashboard toggle (`SETUP.md:221-224`), operator action.
- **GitHub repo rename + Cloudflare D1/R2 resource rename** (rebrand spec §11) — maintainer dashboard actions; the resource rename carries migration risk and stays deliberately deferred. When done, update `wrangler.toml` bindings and SETUP.md in one PR.

---

## 5. Open questions

1. **`private/improvements.md` is unavailable in this checkout** — findings #12, #13, #15–21 (P2/P3) cannot be enumerated or verified here. Before treating §3 as the complete outstanding set, the operator should diff this plan against that file (or paste the P1–P3 list into a follow-up issue). Items 3.2/3.3/3.7/3.8 cover every P1 finding the spec itself names.
2. **CSP production telemetry** (item 3.1): has anyone watched the deployed console for Report-Only violations since PR A shipped? If not, schedule a few days of observation before the flip.
3. **Prod data audit for uniques** (item 3.7): run the duplicate-`addressNormalized` query against remote D1 before `db:migrate:remote`.
4. **Product calls** flagged inline: About copy per-mode (3.5), bootstrap zero-users predicate (3.4), validation caps (3.8) — sensible defaults stated; cheap to change.
