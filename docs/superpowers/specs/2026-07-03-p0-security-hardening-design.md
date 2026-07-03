# P0 Security Hardening — Design

**Date:** 2026-07-03
**Status:** Draft for review
**Branch:** off current `main` (four sequential PRs)
**Addresses:** findings #1–6 (the P0 tier) of `private/improvements.md`, itself a companion to `private/repo-status.md`.

## Context

`private/repo-status.md` is a deep-dive review of this repo; `private/improvements.md`
is its prioritized findings list. The **P0 tier (#1–6)** is security & abuse hardening.
Everything in it targets the "edges" of an otherwise coherent, fail-closed app: the
SMS-sending verification endpoint has no rate limit, document uploads/downloads trust
client input and serve bytes `inline` from the site origin, no response carries security
headers, OTP hashes are unsalted SHA-256 compared non-constant-time, the `board`-granting
surface doesn't match the docs (and exposes impersonation/ban), and `settings` blobs are
persisted and served without validation.

This spec covers **only P0 (#1–6)**. P1–P3 (#7–21) are out of scope and will be planned
separately. The code as it stands on `main` matches the review (verified against
`request.ts`, `codes.ts`, `property.ts`, `documents.ts`, `files/[id].ts`, `middleware.ts`,
`roles.ts`, `members.ts`, `site.ts`, `dues.ts`, `permissions.ts`, `auth/index.ts`,
`types.ts`).

## Goals

- **#1** Rate-limit `/api/verify/request` so no user can spam real SMS/email to residents.
- **#2** Constrain document uploads to a safe type allowlist and serve downloads without
  stored-XSS risk.
- **#3** Set baseline security headers on every response.
- **#4** Store OTPs as keyed HMAC and compare constant-time.
- **#5** Make board-to-board handoff a *supported, deliberate* workflow (promote/demote via
  the admin app), align the docs with reality, and close the impersonation/ban surface.
- **#6** Validate `settings` blobs on write and normalize dues on read.
- Every change carries tests in the existing tiers (`npm test` jsdom, `npm run test:server`
  Worker/D1 integration).

## Non-goals

- **No Google Docs/Sheets/Drive import.** Deferred and documented as a future stretch goal
  (see PR C appendix). Its exported artifacts (Docs→PDF, Sheets→xlsx) already fit the new
  upload allowlist, so nothing here blocks it later.
- **No P1+ work** — CI changes (#7), DB constraints/indexes (#8), broad input validation
  (#9), `locals.authContext` plumbing (#10), payload trimming (#11), and all P2/P3 items are
  separate efforts. (Where a P0 change makes a P1 fix trivial and adjacent, it is noted but
  not required.)
- **No data migration for existing R2 documents.** Download hardening (#2) makes already
  stored files safe regardless of their stored content type; only *new* uploads get the
  canonical-type treatment.

## Delivery

Four PRs off `main`, in dependency-free order. Sequencing follows `improvements.md`'s own
recommendation: batch the quick wins, then one focused PR each for the larger items.

| PR | Findings | Theme |
| --- | --- | --- |
| A | #3, #4, #6 | Quick wins: headers, OTP hardening, settings validation |
| B | #1 | Rate-limit the verification request endpoint |
| C | #2 | Upload allowlist + safe download |
| D | #5 | Board handoff + role-surface tightening (incl. minimal UI) |

---

## PR A — Quick wins (#3, #4, #6)

### #4 — OTP storage (`src/server/verification/codes.ts`)

Today `hashCode(code)` is a bare SHA-256 hex digest and `verifyCode` is a `===` string
compare. Change to a keyed HMAC with a constant-time compare.

- `hashCode(code: string, secret: string): Promise<string>` — import `secret` as an
  HMAC-SHA-256 key (`crypto.subtle.importKey('raw', …, {name:'HMAC', hash:'SHA-256'}, …,
  ['sign'])`), sign the encoded code, return hex.
- `verifyCode(code: string, hash: string, secret: string): Promise<boolean>` — recompute
  and compare with a **constant-time** hex comparison (fixed-length XOR-accumulate; Workers
  has no `timingSafeEqual`). Reject length mismatch without early return.
- **Secret:** reuse `BETTER_AUTH_SECRET` (already provisioned as a wrangler secret / in
  `.dev.vars`; no new setup). No `OTP_PEPPER`.
- **Ripple:** `src/server/verification/property.ts` calls `hashCode`/`verifyCode` in
  `requestPropertyVerification` and `confirmPropertyVerification` — thread
  `env.BETTER_AUTH_SECRET` into both. Update `codes` unit tests to pass a secret.
- **In-flight impact:** codes generated before deploy (10-minute TTL) stop verifying after
  deploy — negligible; a resident just re-requests. `generateCode` (rejection sampling) is
  unchanged.

### #6 — Settings validation (`src/lib/types.ts`, `admin/site.ts`, `admin/dues.ts`, `content/dues.ts`)

- **Site write:** `PUT /api/admin/site` currently does `JSON.stringify(await request.json())`
  verbatim. Run the existing `normalizeSiteSettings` on the parsed body **before**
  persisting.
- **Dues:** add `normalizeDuesSettings(raw: unknown): DuesSettings` in `types.ts`, next to
  `normalizeSiteSettings`. It coerces `amount`/`dueDate`/`notes` to strings (with
  `DEFAULT_DUES_SETTINGS` fallbacks), enforces `paymentOptions` as an array of
  `{label, details, url?}` (coerce `label`/`details` to strings; **keep `url` only if it
  parses as `http(s):`**, else drop the field), and drops unknown keys.
  - Apply on the **write** (`PUT /api/admin/dues`, before persisting) **and** on the public
    **read** (`GET /api/content/dues`, which today returns `JSON.parse(row.value)`
    verbatim). This closes the "dues blob served to the public unvalidated" and
    "`PaymentOption.url` rendered as an `href` with no scheme check" exposures (`url` feeds
    an `<a href>` in `DuesInfo.tsx`).

### #3 — Security headers (`src/middleware.ts`)

Middleware currently returns early with a `context.redirect(...)` for `/admin` and
`/homeowner`, then falls through to `next()`. Restructure so **every** response —
redirect or rendered — passes through a single header-applying step before return.

- Capture the response (`const response = <redirect> ?? await next()`), then set on
  `response.headers`:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-Frame-Options: DENY`
  - `Permissions-Policy` (deny camera/microphone/geolocation etc.)
  - `Content-Security-Policy` — **shipped `Content-Security-Policy-Report-Only` first.**
    Astro injects inline styles and island hydration scripts, so enforce-mode risks visible
    breakage; report-only lets us confirm the policy before flipping it. Allowlist is fully
    enumerable from the code:
    - `frame-src`: `calendar.google.com` (Calendar embed), `challenges.cloudflare.com`
      (Turnstile)
    - `script-src`: `'self'` + `challenges.cloudflare.com` (+ whatever Astro hydration
      needs — determined empirically under report-only)
    - `style-src` / `font-src`: Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`)
    - `connect-src`: `'self'` + `api.web3forms.com` (contact form)
- **HSTS** is a Cloudflare-zone setting, not a Worker header — add a note to `SETUP.md`
  rather than code.
- Headers apply to `/api` responses too (harmless and desirable — e.g. `nosniff` on JSON
  and on the file download).

---

## PR B — #1 Rate-limit `/api/verify/request`

`requestPropertyVerification` (in `property.ts`) fans real SMS/email out to **every active
owner contact** on a matched home, gated only by Turnstile. A signed-in user can burn
Twilio credit and harass residents. Counting existing `property_verifications` rows is
**not** reliable — each request deletes the caller's prior *unconsumed* code, so those rows
vanish and a row count undercounts. Use dedicated KV counters instead (the `KV` binding is
already bound in `wrangler.toml`; no new infrastructure, no schema change).

- New module `src/server/verification/rate-limit.ts`:
  - **Per-user cooldown:** 1 request / 2 min (KV key `verif:cooldown:<userId>`, short TTL).
  - **Per-user daily cap:** 5 / 24h (KV key `verif:day:user:<userId>`, ~24h TTL).
  - **Per-property daily cap:** 5 / 24h (KV key `verif:day:prop:<propertyId>`), so a
    property can't be targeted from multiple accounts.
- **Placement / ordering:** check the cooldown and per-user cap in the endpoint
  (`src/pages/api/verify/request.ts`) *before* the Turnstile/lookup work, returning early on
  breach. The per-property cap is checked inside `requestPropertyVerification` once the
  address resolves to a property, before sends. Increment counters at the point a send is
  actually attempted (the cooldown increments on any accepted request, to also throttle
  queue-row spam).
- **Response:** `429` with a friendly JSON body (`{ ok:false, rateLimited:true, message }`)
  that `VerifyPropertyForm` can display. (Widget-reset on spent Turnstile is finding #14,
  P2 — out of scope, noted.)

---

## PR C — #2 Upload/download constraints

### Upload (`src/pages/api/admin/documents.ts`, `POST`)

Today the handler stores `file.type` (client-controlled) with no type check. Validate by
**file extension** (client MIME for `.md`/`.csv` is unreliable — often empty or
`application/octet-stream`) and store a **canonical server-derived content type**.

- Allowlist (extension → canonical content type):
  - `pdf` → `application/pdf`
  - `txt` → `text/plain`
  - `md` → `text/markdown`
  - `csv` → `text/csv`
  - `doc` → `application/msword`
  - `docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - `xls` → `application/vnd.ms-excel`
  - `xlsx` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Reject any other extension with `415`. Store the **canonical** type in
  `documents.contentType` (ignore `file.type`). Keep the existing 25 MB cap and the `r2Key`
  sanitization. (`text/html` and `image/svg+xml` are deliberately absent — those are the
  stored-XSS vectors.)

### Download (`src/pages/api/files/[id].ts`, `GET`)

- Always set `X-Content-Type-Options: nosniff`.
- `Content-Disposition: inline` **only** when `contentType === 'application/pdf'` (browsers
  preview PDFs safely); `attachment` for everything else.
- Strip control characters (and existing `"`) from `doc.filename` when building the header.
- This makes even pre-existing R2 documents safe to serve regardless of their stored type —
  no backfill needed.

### Appendix — Google Docs/Sheets/Drive import (future stretch goal)

Not implemented here. When built, it will be its own spec: a board pastes a Drive/Docs share
link; the server authenticates to Google (OAuth or service account), exports Docs→PDF and
Sheets→xlsx via the Drive API, and stores the result in R2 through the same document
pipeline. Because exports are PDF/xlsx, they already satisfy this PR's upload allowlist, so
no allowlist change will be needed then.

---

## PR D — #5 Board handoff + role-surface tightening

**Decision:** board-to-board handoff is a *supported* workflow — an outgoing board member
promotes the incoming one, then the incoming one demotes the outgoing one. This reframes
finding #5 from "lock down / delete" to "make it deliberate, safe, and documented," and
closes the unrelated impersonation/ban exposure.

### Role writes → direct DB (`roles.ts`, `members.ts`)

The app already prefers direct DB role writes (`confirmPropertyVerification`, members
`approve`). Move the remaining role changes off the Better Auth admin plugin's `setRole`
onto direct `users.role` writes. `getAuthContext` re-reads role from the DB every request
(fail-closed), so a direct write takes effect on the next request — no session staleness.

- **`POST /api/admin/roles`** (kept, no longer UI-orphaned): allow `grant`/`revoke` of
  `homeowner` **and** `board` via direct DB writes. This is *the* deliberate
  board-management surface.
- **`members.ts`** (homeowner-focused Members panel): `revoke` becomes a direct DB write to
  `visitor`, and **refuses to demote a user whose current role is `board`** (fetch target
  role first; return `409`/`400` with a message pointing to the Board-members path). This
  keeps accidental board demotion out of the homeowner workflow.

### Minimal "Board members" admin section

A small new admin section (component under `src/components/admin/`, wired into
`AdminApp.tsx`'s `SECTIONS`) to drive the handoff from the browser:

- **List** current board members (users with `role === 'board'`: id, name, email).
- **Promote** a user to board **by account email** — server looks the user up by email
  (`404` if no such account), then promotes. (Target must already have registered.)
- **Demote** a listed board member to `visitor`.
- **Guard — never demote the last remaining board member** (require `count(board) > 1`
  before a demotion; returns a clear error). Prevents locking the site out of admin; the
  handoff always has ≥2 board members, so it never blocks the real workflow.
- Reads/writes go through the roles endpoint (extended with a board-list read, or a small
  sibling read) and follow the existing admin manager conventions (`admin-panel` /
  `panel-card` / `list-row`, helper in `lib/admin.ts`).

### Close impersonation/ban (`permissions.ts`, `auth/index.ts`)

With all role changes now direct DB writes, the app no longer calls **any** Better Auth
admin-plugin API. So board no longer needs admin-plugin powers, and the sensitive
`/api/auth/admin/*` surface (set-role, **ban**, **impersonate**, delete-user) can be closed
to board sessions.

- Remove the `...adminAc.statements` spread from the `board` role in `permissions.ts`
  (and/or remove `board` from `adminRoles` in `auth/index.ts`), keeping the admin plugin
  installed for its schema (`role`/`banned` columns) and `defaultRole`.
- **Open unknown to verify with Context7 before finalizing:** exactly how Better Auth's
  `adminRoles` interacts with the access-control `roles`/`ac` — specifically whether
  membership in `adminRoles` grants blanket access regardless of a trimmed role statement.
  The implementation must confirm (via a `test:server` case) that a board session gets `403`
  from `/api/auth/admin/impersonate` and `/api/auth/admin/ban` after the change. Also grep
  the client (`auth-client.ts` and components) to confirm nothing calls admin-plugin
  endpoints before removing the capability.

### Docs

Update `README.md` and `CLAUDE.md`: board members **can** promote/demote other board
members through the admin app (governance handoff); correct the "board is never
self-grantable through the app" wording (a board member cannot escalate beyond board, and
the *first* board is still bootstrapped via `scripts/seed-board.ts`). Reflect that the
Better Auth admin impersonation/ban surface is closed.

---

## Testing

Coverage lands in the existing tiers. New server tests use
`@cloudflare/vitest-pool-workers` (`vitest.workers.config.ts`, `test/server/**`), which apply
real D1 migrations and invoke handlers directly.

- **#4 (unit):** `codes` — HMAC output differs from old SHA-256; `verifyCode` accepts the
  right code and rejects wrong/mismatched-length; wrong secret fails. Verification flow
  (`test/server`) still passes end-to-end with the threaded secret.
- **#6 (unit + server):** `normalizeDuesSettings` drops unknown keys / non-`http(s)` urls /
  malformed `paymentOptions`; `PUT /api/admin/site` and `/dues` persist normalized blobs;
  `GET /api/content/dues` returns normalized output for a hand-mangled stored row.
- **#3 (server):** middleware sets `nosniff`/`X-Frame-Options`/`Referrer-Policy` on both a
  rendered page response and an `/admin` redirect; CSP(-Report-Only) header present.
- **#1 (server):** repeated `/api/verify/request` from one user hits the cooldown → `429`;
  daily cap → `429`; per-property cap trips across two users; a first request within limits
  still sends (asserted via the existing sender mocks).
- **#2 (server):** upload of a disallowed extension → `415`; allowed extensions store the
  canonical content type; download sets `nosniff`, `attachment` for non-PDF and `inline` for
  PDF, and sanitizes the filename header.
- **#5 (server + jsdom):** `roles` grants/demotes board via direct DB write; `members`
  revoke refuses a board target; last-board-member demotion is refused; a board session gets
  `403` from `/api/auth/admin/impersonate`. jsdom test for the Board-members component
  (promote-by-email posts the right payload; demote posts; list renders).

## Rollout

- **PRs A–C** are behavior-preserving hardening with no migration; deploy in order.
- **PR D** changes the role-management surface and adds UI; its docs update ships with it.
  The CSP flips from Report-Only to enforced in a small follow-up once report-only telemetry
  (or manual verification) confirms no legitimate resource is blocked.
- No D1 migration is required by any P0 item (constraints/indexes are #8, P1).
