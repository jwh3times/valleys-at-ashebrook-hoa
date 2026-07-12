# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.12] - 2026-07-12

### Changed

- The assistant's "general knowledge only" empty-retrieval notice now has a distinct tint so it
  stands out from the answer instead of blending in. (Internal: simplified a pseudonymizer dedup
  key; no behavior change.)

## [0.3.11] - 2026-07-12

### Added

- **New document uploads become assistant-searchable automatically.** Uploading a document now
  builds its search index copy (via Cloudflare Workers AI), so board members no longer need an
  operator to re-run the import for a new file to show up in the assistant. Files that can't be
  converted to searchable text (scans or unsupported formats) are marked "Not searchable" in the
  admin Documents panel and still download normally.

## [0.3.10] - 2026-07-12

### Changed

- **Assistant is clearer and more accurate.** When no documents match a question, the answer is now
  flagged as general-knowledge-only; each cited excerpt shows its category and (pseudonymized)
  title; and stale index entries with no matching document are ignored instead of showing an empty
  citation. A "New conversation" button resets the chat.

### Fixed

- **Assistant stops garbling document numbers and words.** The PII pseudonymizer no longer masks
  arbitrary long/bare numbers as phone numbers, and no longer replaces common English words that
  happen to match a resident's name token. Roster phone numbers are still masked in any format, and
  conversation history is fully pseudonymized before any length cap is applied.

### Security

- Document titles sent to the AI provider are now pseudonymized (previously they were withheld);
  roster names, addresses, phones, and emails are still always masked.

## [0.3.9] - 2026-07-12

### Changed

- Documentation and internal tooling only — public docs brought in line with the already-shipped AI
  assistant, a docs-freshness automation fix, and a changelog restructure. No user-facing changes.

## [0.3.8] - 2026-07-12

### Fixed

- **Assistant no longer hangs on a full roster** — the PII pseudonymizer's surrogate name pools
  were finite, so a large enough roster could exhaust them mid-request and spin forever, hanging
  the Worker on every assistant call. Surrogate generation is now injective over an unbounded index
  range (deterministic disambiguation tiers), so it always terminates. Answer generation also gets
  more token headroom so adaptive thinking no longer starves the visible answer, and a cut-off reply
  now shows a visible "cut off by the length limit" notice instead of ending silently.

### Security

- Generated surrogate names are now checked against the roster so a disambiguated placeholder can
  never coincide with a real resident's actual name.

## [0.3.7] - 2026-07-11

### Changed

- **Document search index split from the download library** — the AI assistant now retrieves over
  a dedicated Markdown index (one `rag/<uuid>.md` per document, indexed by Cloudflare AI Search)
  instead of the raw files, so scanned and oversized documents become searchable while citations
  still link to the original human-readable file for download. Deleting or de-duplicating a document
  now also removes its search-index copy. The document library's category list expanded from 5 to 16
  for finer organization.

## [0.3.6] - 2026-07-10

### Changed

- **Hybrid assistant answers** — answers now draw on both the documents and general knowledge,
  clearly labeling which parts come from the documents (cited by `[Source N]`) versus general
  knowledge not found in them.

## [0.3.5] - 2026-07-10

### Fixed

- **Assistant retrieval works in production** — an unexpected Cloudflare AI Search response shape
  returned a production `500` on every question; the response is now normalized so document search
  returns results.

## [0.3.4] - 2026-07-10

### Added

- **Board-only AI document assistant** — ask questions about the document library from the admin
  panel and get streamed answers with per-document citations that link back to the tier-checked
  download (Cloudflare AI Search retrieval + Claude generation).

### Security

- The assistant pseudonymizes known resident PII (current and former owners, best-effort and
  roster-based) before sending document excerpts to Anthropic; document titles are never sent.

## [0.3.3] - 2026-07-10

### Changed

- Internal cleanup of the duplicate-resolution response payload (removed a vestigial `deleteIds`
  field and a stale test payload). No behavior change.

## [0.3.2] - 2026-07-10

### Changed

- Dependency updates (Dependabot: npm minor/patch group).

## [0.3.1] - 2026-07-10

### Changed

- **Duplicate review remembers resolved groups** — resolving duplicates now marks the file(s) a
  board member keeps with a `keep_verified_at`/`keep_verified_by` state, and the admin
  **Duplicates** panel hides any group whose members are all already kept-verified instead of
  re-showing it on every visit. Resolving now takes an explicit list of files to keep alongside
  the files to delete, rather than a single keeper, so a "keep all" action can mark a group
  reviewed without deleting anything. If a later upload is confirmed as a near duplicate of a
  previously-kept file, that file's kept state is cleared so the group resurfaces for review. The
  panel also adds a per-file "View" link and a "kept" badge.

## [0.3.0] - 2026-07-09

### Changed

- **Release-line versioning scheme** — adopted the `<major>.<minor>.<build>` release-line tagging
  used for these releases (the first tag on a line uses the package build value; later merges on the
  same line increment the build segment), replacing the earlier four-part build tags.

## [0.2.2] - 2026-07-09

### Changed

- Dependency updates (Dependabot: npm minor/patch group).

## [0.2.1] - 2026-07-08

### Changed

- Introduced `AGENTS.md` as the canonical contributor/agent guide and pointed the docs and agent
  references at it.

## [0.2.0] - 2026-07-08

Initial public release for the resident-run Valleys at Ashebrook site. This release establishes the
Cloudflare Workers/D1/R2 foundation, homeowner verification, board admin workflows, document
library, security hardening, public documentation cleanup, and the remaining roadmap.

### Added

- **Roadmap, architecture, and ADR docs** — remaining roadmap work now lives in `ROADMAP.md`,
  public architecture is summarized in `docs/architecture.md`, and architecture decision records
  live under `docs/adr/` for durable choices that future roadmap work should preserve.
- **Scheduled verification cleanup** — the Worker now exposes a daily scheduled handler that purges
  old consumed/expired property-verification rows and resolved manual-approval rows through the
  shared cleanup routine.
- **Document deduplication** — documents now store a nullable SHA-256 `content_hash`; board uploads
  block exact duplicates, warn on metadata-only near duplicates with an explicit override, and a new
  admin **Duplicates** panel plus `npm run docs:dedupe` dry-run/commit script help clean up the
  imported archive.
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
  hand-written temporary-route procedure. It requires a bootstrap secret matched in constant time
  plus first-board account config.
- **SEO basics** — a branded custom 404 page, a `robots.txt` (allowing public content, disallowing
  `/admin` and `/api`), and a `/sitemap.xml` of the public content pages. The sitemap is served by
  a small SSR route rather than `@astrojs/sitemap`, which emits nothing under full-SSR output.

### Changed

- **Public setup vs. private operations docs** — public `SETUP.md` now stays generic and
  resident-run-site focused, while deployment-specific runbooks, roster erasure commands,
  bootstrap details, and backup notes belong under gitignored private operations docs.
- **Release-line tag workflow** — the version workflow now allows the first tag on a release line
  to use the package patch value, so this initial release can be tagged `v0.2.0`; later merges on
  the same line continue as `v0.2.1`, `v0.2.2`, and so on.
- **CI and deployment posture** — the build workflow runs the Worker/D1 integration suite, Vitest
  coverage thresholds are set from the current baseline, CodeQL stays in GitHub default setup, and
  production deploys intentionally remain with Cloudflare Workers Builds rather than a duplicate
  GitHub deploy workflow.
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

- **Stale public execution docs** — old implementation handoff files and the
  `docs/superpowers/` scratch/spec tree were removed from the public documentation surface after
  preserving durable decisions in ADRs.
- **Stale Firebase `.gitignore` entries** — the project no longer uses Firebase/Firestore, so the
  `.firebase/` and `*firebase*-debug.log` ignore block was dropped. (The `SESSION` KV binding and
  the `requirePropertyAccess` guard were investigated as possible cruft too but both are
  load-bearing — the binding is required by the Cloudflare adapter and the guard backs a planned
  feature — so they were documented in place rather than removed.)

### Fixed

- **Local sign-in works under `npm run dev`** — `http://localhost:4321` is now a trusted Better Auth
  origin, so signing in on the dev server no longer fails with an origin error (the dev server's
  `BETTER_AUTH_URL` points at the production URL, which had left localhost untrusted). Production
  auth is unaffected.
- **Property-verification flow polish** — the single-use Turnstile token is now reset after every
  verification request, so retrying after a rate-limit or error no longer fails with "Bad captcha";
  the one-time code message now names the (masked) requesting account (e.g. `Requested by
j***@gmail.com`) so a recipient can tell a real request from an attacker probing their contact;
  and a successful confirmation shows a success state with a link to the resident documents (a full
  navigation that re-resolves the now-homeowner role).

### Security

- **Roster PII operating stance** — setup/security docs now state where roster data comes from, that
  it is used for owner verification, how removal requests are handled, and how D1 restore/export
  retention works.
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
  (Google Fonts, the Google Calendar embed, Turnstile, Web3Forms) plus the Cloudflare Web Analytics
  beacon that Cloudflare's edge injects, and was flipped from Report-Only to enforced after auditing
  every resource against the directive list.
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

[Unreleased]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.12...HEAD
[0.3.12]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/releases/tag/v0.2.0
