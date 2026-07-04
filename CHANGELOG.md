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

### Changed

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
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and a Report-Only
  Content-Security-Policy (to be flipped to enforced after validation).
- **HMAC-keyed, constant-time one-time codes** — verification codes are stored only as keyed
  HMAC-SHA-256 hashes and compared in constant time, so a leaked database backup can't be reversed
  with a precomputed table.
- **Settings validated on write, normalized on read** — dues and site settings are coerced and
  validated so malformed values can't reach rendering.
- **Impersonation/ban/set-role closed to board sessions** — the Better Auth admin-plugin
  capabilities are intentionally not granted; all role changes are direct, board-only database
  writes.
- **Public documents read no longer leaks storage metadata** — `GET /api/content/documents` now
  projects only the `DocumentItem` contract (id, title, category, visibility, updatedAt); the
  internal R2 object key, filename, byte size, and content type are no longer sent to callers.

[Unreleased]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/commits/main
