# Implementation Plan — Outstanding Roadmap Items

**Date:** 2026-07-03
**Branch:** `claude/roadmap-implementation-plans-o9740c`
**Repo:** `jwh3times/valleys-at-ashebrook-hoa` (Astro SSR on Cloudflare Workers; D1/Drizzle, R2, KV; Better Auth)

**Sources used (no GitHub issues exist; these are the roadmap of record):**

- `docs/superpowers/plans/2026-07-03-p0-security-hardening.md` + `docs/superpowers/specs/2026-07-03-p0-security-hardening-design.md` — verified task-by-task against code and `git log` (see §1).
- Deferred / out-of-scope / follow-up sections of every other plan+spec pair under `docs/superpowers/{plans,specs}/`: document-library (2026-06-30), identity-and-roles (2026-06-30), resident-rebrand-official-mode (2026-07-01), people-per-home-roster (2026-07-02), roster-admin-ui (2026-07-02).
- `SETUP.md` / `README.md` operational steps that imply engineering work; `grep -rn "TODO|FIXME|XXX|HACK" src/ scripts/` (no actionable hits — the only match is a doc comment in `scripts/import-roster.ts:31`).
- `CHANGELOG.md` `[Unreleased]` (to avoid re-planning shipped work).

**Caveat (resolved 2026-07-03):** the P0 spec derives from `private/improvements.md` (findings
#1–21), and `private/` is gitignored. This revision **cross-references the plan directly against
that file** (it was available in the working tree at revision time) and reconciles every finding —
see the full 21-finding map in **§1.5**. Two things the earlier draft got wrong without that context
are now corrected: **#11 is a public-read payload leak, not admin-write trimming** (new §3.9, split
out of §3.8), and **#14 has three parts, not just the Turnstile reset** (§3.2 expanded). Findings
#12, #13, #15–20 — which the earlier draft said "cannot be enumerated from this repo" — are now
planned as new items (§3.9–§3.15, §4.7–§4.8).

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
| Finding #10 — use `locals.authContext` instead of re-fetching | **Done** (§3.3, PR #36) | `resolveAuthContext(locals, request, env)` (`src/server/authz/api-guards.ts`) reads `locals.authContext` middleware-first with a fail-closed fallback; `requireBoard` now takes `locals`; all `/api/admin/*` and direct call sites resolve the caller once per request. |
| Finding #8 — DB constraints/indexes | **Outstanding** | `src/server/db/schema.ts` has only primary keys (grep for `unique|index` matches nothing beyond PKs); e.g. no unique on `properties.addressNormalized`, no index on `owners.propertyId`, `user_property_links(userId)`, `property_verifications(userId)`, `documents(visibility)`. |
| Finding #9 — broad input validation | **Outstanding** | Admin writes besides site/dues parse request JSON with type assertions and persist coerced-but-unvalidated strings (e.g. `src/pages/api/admin/announcements.ts`, `properties.ts`, `owners.ts`); no length caps. §3.8 — note #9 also spans the *public* read `limit` clamp + malformed-JSON→400 + `members.ts` approve check, added to §3.8's scope below. |
| Finding #11 — trim the **public** documents read payload | **Done** (§3.9, PR #33) | `fetchDocumentsFor` (`src/server/content/reads.ts:7-22`) now projects only the `DocumentItem` columns (id, title, category, visibility, updatedAt); `r2Key`/`filename`/`sizeBytes`/`contentType` no longer reach `GET /api/content/documents`. |
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

`CHANGELOG.md` `[Unreleased]` previously covered the six shipped feature waves but had no entries for
the P0 security hardening or the board-handoff workflow. **Resolved (§3.6):** `[Unreleased]` now
carries `### Security` bullets for the P0 work and an `### Added` bullet for the Board members panel,
and `SECURITY.md` records the same at model altitude.

### 1.5 Full cross-reference against `private/improvements.md` (findings #1–21)

Every finding reconciled against code on 2026-07-03. "Done" rows were verified in §1.1; the rest are
planned below. This table supersedes the earlier "cannot be enumerated" caveat.

| # | Finding | Status | Covered by |
| --- | --- | --- | --- |
| 1 | Rate-limit `/api/verify/request` | **Done** | §1.1 B1–B3 |
| 2 | Constrain document uploads/downloads | **Done** | §1.1 C1–C2 |
| 3 | Baseline security headers | **Done** (CSP Report-Only) | §3.1 flips to enforce |
| 4 | HMAC + constant-time OTP storage | **Done** | §1.1 A1 |
| 5 | Board-granting story + `members.ts` revoke guard | **Done** | §1.1 D1–D5 |
| 6 | Validate settings on write, normalize dues on read | **Done** | §1.1 A2 |
| 7 | Run `test:server` in CI | **Done** | §1.1 follow-up (`build.yml:34`) |
| 8 | DB constraints & indexes | Outstanding | §3.7 |
| 9 | Tighten write-endpoint input handling | Outstanding | §3.8 (scope broadened) |
| 10 | Use `locals.authContext` | **Done** | §3.3 |
| 11 | Trim **public** documents read payload | **Done** | §3.9 |
| 12 | Server-render public content (SSR/SEO) | Outstanding | **§3.10** |
| 13 | Signed-in user presence in the chrome | Outstanding | **§3.11** |
| 14 | Verification-flow polish (3 parts) | Partially planned (only Turnstile reset) | **§3.2 expanded** |
| 15 | Consolidate duplicated UI logic | Outstanding | **§3.12** |
| 16 | Custom 404 + robots/sitemap | Outstanding | **§3.13** |
| 17 | CI/CD rounding-out | Partial — CodeQL claim already reframed (`README.md:75`); deploy workflow + coverage thresholds outstanding | **§4.7** |
| 18 | Scheduled cleanup + observability + stray `console.log` | Partial — **§3.14 done** (`console.log` removed, `[observability]` on); cron outstanding | **§3.14** (done) + **§4.7** (cron) |
| 19 | Repo cruft | **Done** — §3.15: firebase `.gitignore` block dropped; `requirePropertyAccess` kept as reserved-and-documented; `SESSION` documented as adapter-required | **§3.15** |
| 20 | PII stance note (process, not code) | Outstanding | **§4.8** |
| 21 | Bootstrap ergonomics | Outstanding | §3.4 (plan reached this independently from SETUP.md) |

**Bold section numbers are new in this revision.** The earlier draft covered #1–10 and #21 (as 3.4);
#11 was mistargeted and #12–20 were absent.

---

## 2. Sequencing & priority

Security-adjacent work first (finishing the P0 program), then correctness/robustness (P1-shaped), then product backlog. Each numbered item is one small PR off `main`; all are independent unless noted.

| Order | Item | Priority | Size |
| --- | --- | --- | --- |
| 1 | 3.1 Flip CSP to enforce mode | P0 follow-up | S |
| 2 | 3.6 CHANGELOG + SECURITY.md sync for the shipped P0 work — **Done** (this docs pass) | P0 follow-up (docs) | S |
| 3 | 3.9 Trim the public documents read payload (#11) — **Done** | P1 (info-leak) | S |
| 4 | 3.14 Remove stray `console.log` + add Workers observability (#18) — **Done** | P3 (quick win) | S |
| 5 | 3.15 Repo cruft — `.gitignore` firebase block, dead `requirePropertyAccess`, unused `SESSION` binding (#19) — **Done** | P3 (quick win) | S |
| 6 | 3.2 Verification-flow polish — Turnstile reset + OTP requester line + post-confirm refresh (#14) | P1/P2 | S |
| 7 | 3.3 `locals.authContext` plumbing — one auth read per request (#10) — **Done** | P1 | S–M |
| 8 | 3.7 D1 constraints & indexes (#8) | P1 | M |
| 9 | 3.8 Input validation on admin writes + public `limit` clamp + malformed-JSON guard (#9) | P1 | M |
| 10 | 3.4 Seed-board bootstrap hardening (retire the temp-route procedure) (#21) | P1 (ops safety) | M |
| 11 | 3.13 Custom 404 + robots.txt + sitemap (#16) | P2 (SEO) | S |
| 12 | 3.10 Server-render public content (#12) | P2 (biggest UX/SEO win) | M |
| 13 | 3.11 Signed-in user presence in the chrome (#13) | P2 | M |
| 14 | 3.12 Consolidate duplicated UI logic (#15) | P2 | M |
| 15 | 3.5 Admin-managed disclaimer / About copy | P2 | M |
| 16+ | §4 Backlog: 4.7 deploy workflow + coverage thresholds + cleanup cron (#17, #18-cron), 4.8 PII stance note (#20), Google Drive import, per-owner data, bulk roster UI, tenants/payments, AI assistant | P3 / gated | S–XL |

Rationale for the top slots: item 3.1 is the only unfinished step of the P0 rollout plan itself ("the
CSP flips from Report-Only to enforced in a small follow-up"); 3.9/3.14/3.15 are same-day quick wins
(improvements.md's own "quick wins, same day" list) with 3.9 first because it stops leaking storage
metadata to anonymous visitors; 3.2/3.3/3.7/3.8/3.4 are the named P1 findings verifiable from this
repo; 3.13/3.10/3.11/3.12/3.5 are the frontend batch ("when touching the frontend next"). Everything
in §4 needs either a board decision, an operator/dashboard action, or its own design spec before build.

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

### 3.2 Verification-flow polish — Turnstile reset, OTP requester line, post-confirm refresh (#14)

**Objective & rationale.** Finding #14 has **three** sub-items; the earlier draft planned only (b). All three are small and touch the same flow:

- **(a) Post-confirm redirect + session refresh.** After a successful confirm the UI should land the now-verified homeowner on content that reflects their new role. *Partially present:* `src/components/react/AuthForms.tsx:55` already does `window.location.href = '/'` — a full navigation, so middleware re-resolves the role. Remaining gap: `/` is the generic home, not the homeowner-gated content, and there's no explicit "your account is now verified" confirmation. Decide whether to redirect to a homeowner surface (e.g. `/documents`) and/or show a success state before the redirect.
- **(b) Reset the Turnstile widget on a spent token.** Turnstile tokens are single-use. After a 429 (rate-limit) or 400 from `/api/verify/request`, the form keeps the spent token in `window.turnstileToken`; the retry then fails Turnstile ("Bad captcha") with no recovery but a reload.
- **(c) Name the requester in the OTP message.** The code that reaches an owner's phone/email today (`src/server/verification/property.ts:90`) is `Your Valleys at Ashebrook verification code is ${code}. It expires in 10 minutes.` — it doesn't say *who* asked, so a recipient can't tell a legitimate request from an attacker probing their contact. Add the requesting account's (masked) email: e.g. `…requested by j***@gmail.com. If this wasn't you, ignore this.`

**Current state.** (a) `AuthForms.tsx:55` redirects to `/` post-confirm; no homeowner-specific target or success state. (b) `AuthForms.tsx:104-105` reads `(window as …).turnstileToken`; no `window.turnstile.reset()` anywhere in `src/` (grep confirms); server consumes the token in `src/server/authz/turnstile.ts`. (c) `src/server/verification/property.ts:90-91` builds the SMS/email body/subject with no requester identity; the requesting user's email is available in that request's auth context (the caller must be signed in to request verification).

**Design / approach.**

- After every `request()` submission — success or failure — call the Turnstile client API to reset the widget so a fresh token is issued: `window.turnstile?.reset()` (the global is present when the widget script has loaded; optional-chain so tests/jsdom don't crash), and clear `window.turnstileToken`.
- **Decision:** reset unconditionally after submit rather than only on error — a success moves the UI to the confirm stage, so the reset is harmless, and it removes a state branch. **Rejected alternative:** managing the token in React state via an explicit render callback ref — more idiomatic but a larger refactor of how the widget is mounted in the Astro page; not warranted for this fix.
- Type the global once: extend the existing inline `window` casts into a small local declaration (`declare global { interface Window { turnstileToken?: string; turnstile?: { reset: () => void } } }`) in `AuthForms.tsx` (or a `src/lib/turnstile.d.ts`), removing the repeated `as unknown as` casts.

**Step-by-step tasks.**

1. **(b)** `src/components/react/AuthForms.tsx` — in `VerifyPropertyForm.request`, wrap the fetch/response handling in `finally { window.turnstile?.reset(); window.turnstileToken = undefined; }`; add the global type declaration. Check the sibling signup form for the same spent-token bug and apply the same `finally` if present.
2. **(c)** `src/server/verification/property.ts` — thread the requesting user's email into the message builder (it's already resolvable from the request's auth context at the call site) and add a masked-email helper (`j***@gmail.com`) — reuse or add alongside the existing string helpers; append the "requested by … / if this wasn't you, ignore this" line to both the SMS `message` and email body. Keep the code first so it's not truncated by SMS length limits.
3. **(a)** `AuthForms.tsx` — after a successful confirm, show a brief success state and/or redirect to a homeowner surface instead of `/`; if a client-side session cache exists, refresh it so the header/nav reflect `homeowner` immediately (ties into §3.11).
4. Tests: `test/unit/verify-form-ratelimit.test.tsx` — stub `window.turnstile = { reset: vi.fn() }`, assert `reset` after the 429 path and after a successful send; add a `test/server/verify-request-message.test.ts` (or extend the existing verify-request server test) asserting the OTP body contains the masked requester email and the code.
5. Gate + commit `fix(verification): reset Turnstile, name the requester in OTP, refresh after confirm (#14)`.

**Testing plan.** `npx vitest run test/unit/verify-form-ratelimit.test.tsx` plus the full jsdom suite (`npm test`); the new/extended server test (`npm run test:server`); `npm run check`; `npm run format:check`. Manual check in `npm run dev`: submit → rate-limited → resubmit → new token, no "Bad captcha"; confirm a code → lands on homeowner content; inspect a sent code (dev logs) for the requester line.

**Docs updates.** `CHANGELOG.md` `[Unreleased]` → `### Fixed`. No CLAUDE/README/SETUP change (behavioral detail below their altitude).

**Risks & open questions.** (b) is minimal — `turnstile.reset()` on an absent widget is guarded by optional chaining. (c) **mask** the requester email (never send it in full) — it's another person's PII arriving on a third party's device; masking gives the "was this you?" signal without disclosing the full address. Open question (product, low-stakes): the (a) redirect target — `/documents` vs. a dedicated "you're verified" page; default to a success state then `/documents`.

**Size: S–M** (three small changes across one island + one server module).

---

### 3.3 Use `locals.authContext` in API routes — one auth read per request (#10)

**Status: Done — shipped to `main` (PR #36).** `resolveAuthContext` and a `locals`-taking
`requireBoard` landed in `src/server/authz/api-guards.ts`; the plan below is retained for context.

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

**Status: Done — completed in this docs pass.** `CHANGELOG.md` `[Unreleased]` gained the P0
`### Security` bullets + the Board members `### Added` bullet, and `SECURITY.md` records the same at
model altitude.

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

### 3.8 Input validation on admin writes + public-read guards (#9)

**Objective & rationale.** Site/dues writes are normalized (P0 #6), but the other board-only writes (`announcements`, `properties`, `owners`, `documents` metadata fields) parse JSON/FormData with bare type assertions and persist whatever strings arrive — no length caps, no field allowlists, no trimming. Board-only reduces the threat, but a compromised/mistaken board session can bloat D1 rows, break rendering with megabyte strings, or store unexpected keys. (Payload *trimming* — finding #11 — was previously miscounted here; it's a public-read column-leak fix, now planned separately as §3.9.) Finding #9 also has **three public-facing bullets** the admin-write scope missed, folded in here:

- **Clamp `limit` on the public announcements read.** `GET /api/content/announcements` takes a `limit` query and a negative value drops items from the *end* via `slice(0, -n)` (`fetchAnnouncementsFor` in `src/server/content/reads.ts:24` does `rows.slice(0, limit)`; the endpoint parses the query). Clamp to a non-negative integer at the endpoint.
- **Guard malformed JSON bodies.** `request.json()` on a malformed body throws → opaque 500 across the write endpoints; wrap and return 400.
- **`members.ts` approve → validate `propertyId`.** The approve action links a user to a property without confirming the `propertyId` exists and is active — verify before linking (405/404 on a bad/inactive id).

**Current state.** `src/pages/api/admin/announcements.ts` (POST/PUT bodies asserted to `Announcement`-ish shapes), `src/pages/api/admin/properties.ts` / `owners.ts` (roster CRUD from `RosterManager`), `src/pages/api/admin/documents.ts` (title/category/visibility fields from FormData; visibility already checked against `VISIBILITIES`). `src/lib/types.ts` has the normalize pattern to copy.

**Design / approach.**

- Extend the established normalizer pattern rather than adopting a validation library: per-shape `normalizeAnnouncementInput`, `normalizePropertyInput`, `normalizeOwnerInput` in `src/lib/types.ts` (shared with the client for pre-submit trimming) — coerce to string, `trim()`, enforce max lengths (title 200, body 10 000, address 300, name 200, notes 2 000, email 320, phone 32 — constants exported), validate enums (`visibility` via existing `Visibility`, owner/property `status` ∈ `active|inactive`), drop unknown keys, and **reject** (400 with a field message) rather than silently default when a *required* field is empty (title, address, fullName) — creating content is not the read path, so fail loudly. **Rejected:** zod/valibot — a new dependency and idiom for ~4 shapes when the codebase already has a tested hand-rolled pattern.
- Dates: announcements `date` must parse as ISO `YYYY-MM-DD` (regex + `Date` sanity) else 400.

**Step-by-step tasks.**

1. `src/lib/types.ts` — add the three input normalizers + length constants (unit tests first: `test/unit/input-normalize.test.ts` covering trim, cap, unknown-key drop, enum reject, required-field reject).
2. Wire into `src/pages/api/admin/announcements.ts`, `properties.ts`, `owners.ts` (and the FormData fields in `documents.ts`: trim/cap `title`, validate `category` against `DOCUMENT_CATEGORIES`). Wrap each `request.json()` in a try/catch → 400.
3. Public-read guards: clamp `limit` to a non-negative integer in `src/pages/api/content/announcements.ts` before calling `fetchAnnouncementsFor`; in `src/pages/api/admin/members.ts` approve, look up the `propertyId` and refuse if missing/inactive.
4. Server tests: extend `test/server/admin-announcements-board.test.ts`, `admin-properties.test.ts`, `admin-owners.test.ts`, `admin-documents-board.test.ts` with over-length body → 400, unknown key not persisted, whitespace-only required field → 400, happy path trimmed; add cases for a malformed JSON body → 400, a negative `limit` on the public read (no items dropped), and `members.ts` approve with a bad `propertyId` → 4xx.
5. Client: `RosterManager.tsx` / `AnnouncementsManager.tsx` surface the 400 message (they already render error strings from failed fetches via `src/lib/admin.ts` — verify and extend if the helper swallows bodies).
6. Gate + commit `fix(admin): validate admin writes + clamp public limit + guard malformed bodies (#9)`.

**Testing plan.** New unit file + extended server suites; full `npm test && npm run test:server && npm run check && npm run format:check && npm run build`.

**Docs updates.** CHANGELOG `### Changed`/`### Security`; CLAUDE.md `src/lib/types.ts` bullet gains "+ input normalizers". README/SETUP unaffected.

**Risks & open questions.** Risk: an existing admin UI flow sends a field the normalizer drops (mitigated by running the jsdom manager suites, which assert exact payloads). Open question: exact caps are judgment calls — the numbers above are stated defaults; being wrong costs a one-line constant change (low-stakes).

**Size: M**.

---

### 3.9 Trim the public documents read payload (#11)

**Status: Done — shipped to `main` (PR #33).** `fetchDocumentsFor` now projects only the
`DocumentItem` columns; the plan below is retained for context.

**Objective & rationale.** `GET /api/content/documents` returns internal storage metadata — `r2Key`, `contentType`, `sizeBytes` — to every anonymous visitor, beyond the `DocumentItem` contract. `r2Key` in particular discloses the internal R2 object layout (`documents/<id>/…`). Select only the contracted columns. (This is the *real* finding #11 — it was previously miscounted under §3.8's admin-write trimming.)

**Current state (verified).** `src/server/content/reads.ts:7-12` — `fetchDocumentsFor` is a bare `.select()` (= `SELECT *`) over `documents`; the public route ships the whole row. The download link goes through `GET /api/files/[id]`, which re-reads the row server-side, so the public list payload does **not** need `r2Key`/`contentType`/`sizeBytes`.

**Approach.** Replace the bare select with an explicit projection: `.select({ id, title, category, visibility, updatedAt })` (Drizzle column refs). Confirm `DocumentItem` (`src/lib/types.ts`) and its consumers (`DocumentsList`, `groupDocumentsByCategory`) reference only those fields; admin reads go through `/api/admin/*`, not this path, so they're unaffected. Leave `fetchAnnouncementsFor` selecting all (all announcement columns are legitimately used).

**Step-by-step tasks.**

1. Narrow the select in `src/server/content/reads.ts`; adjust the return type / `DocumentItem` if it currently carries the dropped fields.
2. Extend `test/server/content-reads-*.test.ts` (or the documents-read suite) to assert the response body has **no** `r2Key`/`contentType`/`sizeBytes`.
3. Gate + commit `fix(content): stop leaking R2 storage metadata in the public documents read (#11)`.

**Testing plan.** `npm run test:server` (content-read + files-download suites), `npm test`, `npm run check`, `npm run build`.

**Docs updates.** CHANGELOG `### Security`. **Risks:** a consumer silently relied on a dropped field — the jsdom `DocumentsList` suite is the net. **Size: S.**

---

### 3.10 Server-render public content (#12) — biggest UX/SEO win

**Objective & rationale.** Announcements, documents, and dues are public data rendered inside `client:only="react"` islands, so the server HTML is only "Loading…": bad for SEO, slower first paint, broken with JS disabled. The server read helpers already exist and middleware already resolves the role — this is plumbing, not new capability.

**Current state (verified).** `src/pages/{announcements,documents,dues,index}.astro` all mount `client:only="react"` islands that fetch `/api/content/*` on the client via `src/lib/content.ts`. Server helpers `fetchAnnouncementsFor`/`fetchDocumentsFor` (+ the dues read) live in `src/server/content/`. Middleware sets `Astro.locals.authContext` and `Astro.locals.site`.

**Approach.** In each page's frontmatter, call the server read for `Astro.locals.authContext`'s role and pass rows as props. Islands either seed from props (documents/dues keep hydration for grouping/links) or become plain Astro markup where there's no interactivity (`AnnouncementsList` has none — it can render server-side and drop the island). Keep the `/api/content/*` endpoints for the admin panel and any client refresh. Composes with §3.9 (narrowed columns land in the SSR payload too) and §3.11 (role-aware chrome). **Rejected:** client fetch with an SSR fallback — more complex than reading in frontmatter, which this stack already supports.

**Step-by-step tasks.**

1. `announcements.astro` + `index.astro` (limit 3, server-side — subsumes the home-page slice in §3.12) — fetch and render list markup (or seed the island).
2. `documents.astro` — fetch + group server-side, pass to `DocumentsList` (keep hydration for interactivity).
3. `dues.astro` — fetch + pass to `DuesInfo`.
4. Remove the now-dead client fetches where an island became static.
5. Tests: extend `test/server/**` page/middleware coverage to assert SSR HTML contains real content (not "Loading…") per tier; keep island unit tests for any that stay hydrated.
6. Gate + commit `feat(content): server-render public announcements/documents/dues (#12)`.

**Testing plan.** `npm run test:server`, `npm test`, `npm run check`, `npm run build`; manual `npm run dev` with JS disabled → content visible; view-source shows announcements.

**Docs updates.** CLAUDE.md "Rendering model" note (public reads SSR'd in frontmatter); CHANGELOG `### Changed`. **Size: M.**

---

### 3.11 Signed-in user presence in the chrome (#13)

**Objective & rationale.** The header's only auth affordance is "Admin sign in" → `/admin`. Homeowners have no nav path to `/login`, `/register`, or `/verify-property`, no indication they're signed in, and no sign-out outside the admin panel.

**Current state (verified).** `src/components/Header.astro:50` hardcodes `<a class="nav-login" href="/admin">Admin sign in</a>`. Middleware already exposes `Astro.locals.authContext` (role + `propertyIds`). No account menu / sign-out in the public chrome.

**Approach.** Drive a small account affordance in `Header.astro` from `Astro.locals.authContext`: anonymous → "Sign in" (`/login`) + "Register" (`/register`); signed-in homeowner with empty `propertyIds` → surface "Verify your property" (`/verify-property`); signed-in → an account menu with sign-out; board keeps the "Admin" link. Header is `.astro`, so read `locals` directly; sign-out is a tiny `client:idle` control (Better Auth client `signOut`, or a form posting to the auth route). Ties into §3.2(a) (post-confirm the header reflects the new role after navigation) and §3.10.

**Step-by-step tasks.**

1. `Header.astro` — branch on `authContext.role`/`propertyIds` for the affordances above.
2. Add the sign-out control (small island or a POST form to the Better Auth sign-out route).
3. Tests: `test/server/**` header/middleware render asserts each state's links; a jsdom test if the sign-out island has logic.
4. Gate + commit `feat(nav): homeowner account presence + sign-out in the header (#13)`.

**Testing plan.** `npm run test:server`, `npm test`, `npm run check`, `npm run build`; manual click-through per role.

**Docs updates.** CHANGELOG `### Added`. **Size: M.**

---

### 3.12 Consolidate duplicated UI logic (#15)

**Objective & rationale.** Three concrete duplications: (a) two login forms; (b) the admin managers repeat load/busy/msg/error scaffolding ~5×; (c) the home page fetches **all** announcements then slices 3 client-side.

**Current state (verified).** (a) `src/components/admin/Login.tsx` **and** a `LoginForm` in `src/components/react/AuthForms.tsx` both exist. (b) No `useAdminResource`/`useAsyncAction` hook exists (grep: no matches). (c) `src/lib/content.ts:10` `fetchAnnouncements()` hits `/api/content/announcements` with **no** `limit`, and `index.astro:58` passes `limit={3}` to the island — so the client fetches every announcement and slices client-side (the API already accepts a `limit` query; see §3.8's clamp).

**Approach.** (a) Keep the login form wired into the live routes; delete the other + its imports. (b) Extract `useAdminResource<T>()` encapsulating `load()/busy/error/message`; migrate the managers (`RosterManager`, `MembersManager`, `BoardMembersManager`, `AnnouncementsManager`, `DocumentsManager`, `SiteManager`) incrementally. (c) If §3.10 lands, `index.astro` fetches `limit=3` server-side and this bullet is **subsumed**; otherwise add a `limit?` param to `fetchAnnouncements` and pass 3. **Rejected:** a state-management library — a hook suffices at this size.

**Step-by-step tasks.**

1. De-dup the login form.
2. Add `src/components/admin/useAdminResource.ts` (+ unit test); migrate managers onto it.
3. Fold the home-page slice into §3.10, or add the `limit` param to `fetchAnnouncements`.
4. Run the jsdom manager + auth-form suites (they assert payloads/behavior — the refactor's safety net).
5. Gate + commit `refactor(ui): single login form + shared admin-resource hook (#15)`.

**Testing plan.** `npm test`, `npm run check`, `npm run format:check`, `npm run build`.

**Docs updates.** CHANGELOG `### Changed`. **Size: M.**

---

### 3.13 Custom 404 + robots.txt + sitemap (#16)

**Objective & rationale.** No `src/pages/404.astro`, `public/robots.txt`, or sitemap — three quick wins for a public site; `site` is already configured, so `@astrojs/sitemap` works with minimal setup.

**Current state (verified).** `src/pages/404.astro` — absent; `public/robots.txt` — absent; no `sitemap`/`@astrojs/sitemap` reference in `astro.config`/`package.json`.

**Approach.** (1) `src/pages/404.astro` using the site layout (branding from `Astro.locals.site`, a "back home" link). (2) `public/robots.txt` — allow public content, `Disallow: /admin` and `/api`, plus a `Sitemap:` line. (3) `@astrojs/sitemap` integration, **excluding** `/admin` and `/api/*`. **Note (SSR caveat):** with `output: 'server'`, `@astrojs/sitemap` only emits for statically known routes — confirm it captures the public pages, or generate a small static sitemap of the known public URLs if the integration comes up empty under SSR.

**Step-by-step tasks.**

1. Add the 404 page.
2. Add `public/robots.txt`.
3. Add + configure the sitemap integration with exclusions; `npm run build` confirms `/sitemap-index.xml` (or the static file) is emitted.
4. Gate + commit `feat(seo): custom 404, robots.txt, sitemap (#16)`.

**Testing plan.** `npm run build` (sitemap emission), `npm run check`; manual 404 hit in `npm run dev`.

**Docs updates.** CHANGELOG `### Added`. **Size: S.**

---

### 3.14 Remove the stray `console.log` + enable Workers observability (#18, quick-win parts)

**Status: Done — shipped to `main` (PR #34).** The stray `console.log` is removed and
`[observability]` is enabled in `wrangler.toml`; the scheduled-cleanup cron (#18's third bullet)
remains in §4.7.

**Objective & rationale.** Two of #18's three bullets are one-line quick wins (the third — a scheduled-cleanup cron — needs a trigger + handler and is §4.7). Drop the leftover debug log and turn on Workers Logs so production is observable.

**Current state (verified).** `src/pages/api/content/site.ts:8` has `console.log('GET /api/content/site');`. `wrangler.toml` has no `[observability]` block (grep: no `observability`/`triggers`/`crons`).

**Step-by-step tasks.**

1. Delete the `console.log` line in `site.ts`.
2. Add `[observability]` `enabled = true` to `wrangler.toml` (Workers Logs; no code change).
3. Gate + commit `chore(obs): enable Workers Logs; drop stray debug log (#18)`.

**Testing plan.** `npm run check`, `npm run build` (validates wrangler config). **Docs:** CHANGELOG `### Changed`. **Size: S.**

---

### 3.15 Repo cruft — abandoned Firebase ignores, dead code, unused binding (#19)

**Status: Done — shipped to `main` (PR #35).** The firebase `.gitignore` block was dropped;
`requirePropertyAccess` and the `SESSION` binding proved load-bearing (reserved feature / adapter
requirement) and were documented in place rather than removed. The plan below is retained for
context.

**Objective & rationale.** Housekeeping from #19. `firestore.indexes.json` is **already deleted**; the remaining items are a stale `.gitignore` block, dead exported code, and a possibly-unused Cloudflare binding.

**Current state (verified).** (a) `.gitignore:17-21` still carries the Firebase block (`# firebase`, `.firebase/`, `firebase-debug*.log`, `firestore-debug.log`) though no Firebase remains. (b) `src/server/authz/guards.ts:18` exports `requirePropertyAccess` with **no callers** in `src/` (grep confirms only the definition). (c) `wrangler.toml:20-22` binds `SESSION` (Astro Sessions store) but nothing in `src/` reads it (grep: no `SESSION` usage).

**Approach.** (a) Drop the Firebase lines from `.gitignore`. (b) Remove `requirePropertyAccess` (+ now-unused imports) — or, if it's meant to back the future homeowner-data feature (§4.2), keep it with a `// reserved for …` note; **default: remove**, re-add when used. (c) **Verify before removing `SESSION`:** the `@astrojs/cloudflare` adapter's session store may require the binding at build time — try removing it and run `npm run build`; if the adapter errors, keep it and instead document in CLAUDE.md that it's adapter-required, not dead.

**Step-by-step tasks.**

1. Trim the `.gitignore` Firebase block.
2. Delete `requirePropertyAccess` from `guards.ts`.
3. Attempt `SESSION` removal from `wrangler.toml`; `npm run build` — revert + document if the adapter needs it.
4. `npm run check` (dead-code removal must not break types).
5. Gate + commit `chore: drop firebase ignores, dead requirePropertyAccess, unused SESSION binding (#19)`.

**Testing plan.** `npm run check`, `npm test`, `npm run test:server`, `npm run build`.

**Docs updates.** CLAUDE.md only if `SESSION` stays (note why); CHANGELOG `### Removed`. **Size: S.**

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

### 4.7 CI/CD rounding-out + scheduled cleanup (#17, #18-cron)

- **Deploy workflow on `main` (#17).** Only `build.yml` + `version.yml` exist; `wrangler.toml` comments assume "Git auto-deploys," but no deploy workflow enforces it. Add a `wrangler-action` job gated on `main`, after the build gate, deploying `dist/server/wrangler.json` (`-c`). **Gated on operator action:** mint a scoped `CLOUDFLARE_API_TOKEN` repo secret first. **Size: S** + operator setup.
- **CodeQL (#17) — already resolved.** `README.md:75` documents CodeQL via GitHub's default setup (no workflow by design). No action; listed so the finding is closed, not lost.
- **Coverage thresholds (#17).** `vitest.config.ts:16-20` configures v8 coverage (include/exclude) but sets **no `thresholds`**. Optionally add `coverage.thresholds` (start with a low floor, ratchet up) so coverage regressions fail CI. Policy call (floor vs. advisory) — deferred. **Size: S.**
- **Scheduled cleanup cron (#18).** A Workers Cron Trigger (`[triggers] crons = [...]` + a `scheduled()` handler) to purge consumed/expired `property_verifications` and resolved `manual_approval_queue` rows — or a board-visible "housekeeping" admin action. Needs its own small design round: where the scheduled handler lives in an Astro SSR Worker (the `@astrojs/cloudflare` adapter's handler wiring), idempotent delete queries, and a pool test. **Size: M.**

### 4.8 PII stance note (#20) — process/docs, not code

The roster puts the whole neighborhood's names, phones, and emails in one resident's personal Cloudflare account while the site is explicitly unofficial. Add a short note in `SETUP.md` and/or the `/about` page (`src/pages/about.astro` exists): where the data came from, that it's used **only** for owner verification, how a neighbor asks to be removed, and a backup/retention statement (D1 Time Travel for restore; occasional `wrangler d1 export` for backup). Cheap to write; a lot of goodwill if ever questioned. The removal/contact wording could live in the board-editable About block (§3.5). **Size: S (writing).**

---

## 5. Open questions

1. **`private/improvements.md` cross-reference — done (2026-07-03).** All 21 findings are reconciled in §1.5; #11 was corrected (it's a public-read metadata leak, §3.9, not admin-write trimming) and #12–20 are now planned (§3.9–3.15, §4.7–4.8). Nothing in improvements.md remains unaccounted for. Reminder: `private/improvements.md` stays gitignored because its P0 section is exploit-level detail; this **public** plan describes only the *outstanding* items at task altitude — keep it that way when editing (don't paste vulnerability write-ups here).
2. **CSP production telemetry** (item 3.1): has anyone watched the deployed console for Report-Only violations since PR A shipped? If not, schedule a few days of observation before the flip.
3. **Prod data audit for uniques** (item 3.7): run the duplicate-`addressNormalized` query against remote D1 before `db:migrate:remote`.
4. **Product calls** flagged inline: About copy per-mode (3.5), bootstrap zero-users predicate (3.4), validation caps (3.8) — sensible defaults stated; cheap to change.
