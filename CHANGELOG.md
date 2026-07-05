# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **No official releases yet.** The site is continuously deployed from `main`; no versioned tags
> have been published. Everything below is unreleased and may change before the first tagged
> release. When that release is cut, the items under **Unreleased** will move into a dated,
> versioned section.

## [Unreleased]

### Added

- **Board-editable disclaimer and About copy** — the footer "not affiliated" disclaimer and the
  `/about` page text are now editable from the admin **Site Settings** panel (two new fields on the
  site settings blob — no migration). Left blank, both fall back to the built-in copy, so existing
  deployments render unchanged; changing this text no longer needs a code deploy.
- **Signed-in presence in the header** — the public header now reflects the visitor: anonymous
  users get **Sign in** / **Register** links, a signed-in user without a verified home gets a
  **Verify your property** link, board members get an **Admin** link, and any signed-in user gets a
  **Sign out** control — replacing the single hardcoded "Admin sign in" link. Homeowners no longer
  have to guess the `/login`, `/register`, or `/verify-property` URLs.
- **Tiered content + document library** — site content served from Cloudflare D1 with
  `public | homeowner | board` visibility tiers, document files in R2 behind a tier-checked
  download endpoint, and an import pipeline for the document archive (replacing the earlier
  Firebase/Firestore stack).
- **Identity & roles** — homeowner and board accounts on Better Auth (email/password + admin
  plugin), with possession-based homeowner verification: a one-time code sent to the phone/email
  already on the owner roster (Resend / Twilio), gated by Cloudflare Turnstile. Roles are enforced
  server-side and fail-closed.
- **Resident rebrand + official mode** — the public site is branded "The Valleys at Ashebrook
  Residents", with an admin-toggleable official-mode flag that switches on official-HOA
  presentation (branding, footer disclaimer, HOA-only surfaces such as dues).
- **People-per-home roster** — the flat owner list split into `properties` (homes) and `owners`
  (people), verification matched by home with the code fanned out to all contacts on file, and a
  per-person spreadsheet import.
- **Roster & members admin UI** — board-only Roster (properties/owners CRUD) and Members
  (approval queue / revoke) sections in the admin panel.
- **Board members admin panel** — a board-only **Board members** section that promotes another
  account to `board` and demotes a board member (the last remaining board member can't be demoted),
  making board handoff a supported workflow via direct database writes rather than the Better Auth
  admin API.
- **Admin content management** — announcements, documents, dues, and site settings managed through
  the board-only admin panel.
- **First-board bootstrap endpoint** — a permanent `POST /api/bootstrap/board` creates the very
  first `board` account (which can't be made through the self-service flow), replacing the old
  hand-written temporary-route procedure. It requires an `x-bootstrap-secret` header matched in
  constant time plus `BOARD_EMAIL`/`BOARD_PASSWORD`/`BOARD_NAME` config.
- **SEO basics** — a branded custom 404 page, a `robots.txt` (allowing public content, disallowing
  `/admin` and `/api`), and a `/sitemap.xml` of the public content pages. The sitemap is served by
  a small SSR route rather than `@astrojs/sitemap`, which emits nothing under full-SSR output.

### Changed

- **Shared admin-manager scaffolding** — the board admin managers (announcements, documents, dues,
  site settings, roster, board members) now share a `useAdminResource` hook for the load / busy /
  status-message boilerplate each was repeating by hand, instead of duplicating the same
  `try/catch/finally` save logic six times. No behavior change.
- **Public content is now server-rendered** — announcements, documents, and dues are read in each
  page's Astro frontmatter (tier-filtered by the visitor's role) and rendered server-side instead of
  fetched client-side into `client:only` islands. The HTML now ships with the real content — better
  SEO, faster first paint, and it works with JavaScript disabled — rather than a "Loading…"
  placeholder. The `/api/content/*` endpoints remain for the admin panel.
- **Database uniqueness + hot-path indexes** — migration `0003` adds a `UNIQUE` index on
  `properties.address_normalized` and on `user_property_links (user_id, property_id)`, plus indexes
  on the roster/verification/content hot-read columns (`owners.property_id`,
  `property_verifications.user_id`, `manual_approval_queue.status`, `documents.visibility`,
  `announcements (visibility, date)`). Creating or renaming a property to a duplicate address now
  returns `409` instead of an opaque `500`, and re-verifying (or re-approving) a home no longer
  accumulates duplicate ownership links.
- **Enabled Workers Logs** — `[observability]` turned on in `wrangler.toml` so production
  invocation logs, console output, and errors are visible from the Cloudflare dashboard. Also
  removed a stray `console.log` from the site-settings read endpoint.
- **Resolve the caller once per request** — API routes now read the auth context the middleware
  already put on `locals` (via a new `resolveAuthContext` helper and a `requireBoard` that takes
  `locals`), instead of each route re-running a full Better Auth session + D1 role/link lookup. A
  fail-closed fallback preserves behavior when `locals` is absent (e.g. direct handler invocation
  in tests).

### Removed

- **Stale Firebase `.gitignore` entries** — the project no longer uses Firebase/Firestore, so the
  `.firebase/` and `*firebase*-debug.log` ignore block was dropped. (The `SESSION` KV binding and
  the `requirePropertyAccess` guard were investigated as possible cruft too but both are
  load-bearing — the binding is required by the Cloudflare adapter and the guard backs a planned
  feature — so they were documented in place rather than removed.)

### Fixed

- **Property-verification flow polish** — the single-use Turnstile token is now reset after every
  verification request, so retrying after a rate-limit or error no longer fails with "Bad captcha";
  the one-time code message now names the (masked) requesting account (e.g. `Requested by
  j***@gmail.com`) so a recipient can tell a real request from an attacker probing their contact;
  and a successful confirmation shows a success state with a link to the resident documents (a full
  navigation that re-resolves the now-homeowner role).

### Security

- **Verify-request rate limiting** — `POST /api/verify/request` is throttled in KV with a per-user
  cooldown plus daily caps per user and per property; the limit surfaces as a `429` in the verify
  form, curbing abuse of the SMS/email fan-out.
- **Document upload allowlist + canonical content type** — uploads are restricted to an extension
  allowlist and stored with a server-derived content type (HTML and SVG excluded as stored-XSS
  vectors); disallowed types are rejected with `415`.
- **Hardened document downloads** — responses are sent with `nosniff`, forced to `attachment` for
  anything other than PDF, and given a sanitized filename.
- **Baseline security headers** — every response now carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an **enforced**
  Content-Security-Policy. The policy allows exactly the third-party resources the site uses
  (Google Fonts, the Google Calendar embed, Turnstile, Web3Forms) and was flipped from Report-Only
  to enforced after auditing every resource against the directive list.
- **HMAC-keyed, constant-time one-time codes** — verification codes are stored only as keyed
  HMAC-SHA-256 hashes and compared in constant time, so a leaked database backup can't be reversed
  with a precomputed table.
- **Settings validated on write, normalized on read** — dues and site settings are coerced and
  validated so malformed values can't reach rendering.
- **Impersonation/ban/set-role closed to board sessions** — the Better Auth admin-plugin
  capabilities are intentionally not granted; all role changes are direct, board-only database
  writes.
- **Fail-closed first-board bootstrap** — the new `POST /api/bootstrap/board` self-disables the
  moment any board account exists (`410`), so the bootstrap can no longer be a forgotten,
  standing role-escalation route the way the previous hand-added temporary endpoint could. A
  missing `BOOTSTRAP_SECRET` is treated as closed (`403`), never as "unset means open".
- **Public documents read no longer leaks storage metadata** — `GET /api/content/documents` now
  projects only the `DocumentItem` contract (id, title, category, visibility, updatedAt); the
  internal R2 object key, filename, byte size, and content type are no longer sent to callers.
- **Admin write validation** — announcement, property, owner, and document writes now trim, cap
  length, validate enums/dates, drop unknown keys, and reject empty required fields with a `400`
  (instead of persisting coerced, unvalidated strings). Malformed JSON bodies return `400` rather
  than an opaque `500`, the public announcements `limit` is clamped to a non-negative integer (a
  negative value previously dropped items off the end), and the members "approve" action refuses a
  `propertyId` that doesn't exist (`404`) or is inactive (`409`).

[Unreleased]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/commits/main
