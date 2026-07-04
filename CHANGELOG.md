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
- **Admin content management** — announcements, documents, dues, and site settings managed through
  the board-only admin panel.

### Changed

- **Enabled Workers Logs** — `[observability]` turned on in `wrangler.toml` so production
  invocation logs, console output, and errors are visible from the Cloudflare dashboard. Also
  removed a stray `console.log` from the site-settings read endpoint.

[Unreleased]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/commits/main
