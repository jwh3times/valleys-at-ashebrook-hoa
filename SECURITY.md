# Security Policy

## Supported versions

This repository powers a single, continuously deployed website (Cloudflare Workers). The latest
state of `main` is the only supported version — there are no released versions or backports.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: open a private report via **GitHub → Security →
  [Report a vulnerability](https://github.com/jwh3times/valleys-at-ashebrook-hoa/security/advisories/new)**.
- Alternatively, email **<jerryholland00@gmail.com>** with the details and reproduction steps.

Please include the affected URL/endpoint or component, the impact, and steps to reproduce. We aim
to acknowledge within a few days and will coordinate a fix and disclosure timeline with you.

## Security model

- **Access is enforced server-side and fail-closed.** Roles are `visitor | homeowner | board`;
  content visibility tiers are `public | homeowner | board`. Anonymous users resolve to `visitor`
  and unknown states resolve to the most restrictive tier. Document downloads are tier-checked on
  the server before the R2 object is served.
- **`board` is never self-grantable, and board handoff is a supported workflow.** A user's role is
  a column on the user record. A board member can promote another account to `board` and demote a
  board member from the admin panel's **Board members** section (the last remaining board member
  can't be demoted), but cannot escalate their own access beyond `board`. These are direct database
  writes: the Better Auth admin plugin's impersonation, ban, and set-role endpoints are deliberately
  not granted to board sessions. The first board account is bootstrapped through a permanent,
  fail-closed `POST /api/bootstrap/board` endpoint that is inert once any board account exists and
  requires a constant-time secret match plus `BOARD_*` config (see `SETUP.md` §6).
- **Homeowner verification is possession-based and throttled.** Sign-up is verified against the
  owner roster via a one-time code sent to the phone/email already on file (Resend / Twilio), gated
  by Cloudflare Turnstile. Codes are stored only as keyed HMAC-SHA-256 hashes and compared in
  constant time, so a leaked database backup can't be reversed with a precomputed table.
  Verification requests are rate-limited in KV — a short per-user cooldown plus daily caps per user
  and per property — to curb abuse of the SMS/email fan-out.
- **Every response carries baseline security headers.** Middleware sets `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an **enforced**
  Content-Security-Policy that allowlists only the third-party resources the site uses (Google
  Fonts, the Google Calendar embed, Turnstile, Web3Forms, and the Cloudflare Web Analytics beacon).
  HSTS is not enabled by the Worker or repository yet; it remains a Cloudflare zone-level operator
  action.
- **Document files are constrained on upload and download.** Uploads are limited to an extension
  allowlist with a server-derived canonical content type and a size cap (HTML and SVG are excluded
  as stored-XSS vectors; disallowed types are rejected with `415`). Downloads are sent with
  `nosniff`, forced to `attachment` for anything other than PDF, and given a sanitized filename.
- **Secrets never live in the repo.** Runtime secrets (auth, Resend, Twilio, Turnstile) are set as
  Cloudflare Worker secrets via `wrangler secret put` (see `SETUP.md`); only `PUBLIC_*` build-time
  variables are non-secret. `.env` files are git-ignored.
- **The roster is personal data, used only for verification.** Owner names, emails, and phone
  numbers live only in the D1 database — never in committed files — and drive nothing but the
  one-time verification code sent to the contact already on file. Public docs describe the purpose
  and high-level handling; deployment-specific removal, erasure, backup, and retention runbooks
  belong under `private/`.
- **The admin document assistant is board-only and pseudonymizes known PII before it leaves the
  Worker.** `POST /api/admin/assistant` is gated by `requireBoard` (fail-closed, same as every other
  admin endpoint). Answering a question sends retrieved document excerpts, the question, and recent
  chat history to Anthropic; before any of that text is transmitted, every roster owner name and
  property address is swapped for a realistic, consistent placeholder — including each individual
  name token (so a resident's standalone first name or surname is also replaced, not just their full
  name) — except tokens that are common English words, which are left intact so ordinary document
  text is not garbled — and any email address found anywhere in the text is pseudonymized the same
  way; roster phone numbers are pseudonymized in any format (including bare digits), and any number
  written in a standard phone format (parenthesized area code or separators) is pseudonymized
  whether or not it matches the roster. Document titles are pseudonymized the same way and sent as
  part of each excerpt label; citations
  reference retrieved excerpts by index label and are resolved back to real documents server-side.
  This is **best-effort, not a guarantee**: it only catches PII matching a current roster entry or
  the email/phone patterns, so it does not cover non-resident names or other free text that doesn't
  match those patterns, and has narrow documented edge cases (for example, a roster value whose
  closing abbreviation period is glued directly to the next word with no separating space).
- **The AI Search index is not tier-aware, which is why the assistant stays board-only.** Retrieval
  runs over a single Cloudflare AI Search index built from every document's Markdown text
  (`rag/<uuid>.md`) regardless of that document's visibility tier, and returns un-pseudonymized
  excerpt **text** for the model to compose an answer from — only the citation _link_ is tier-checked
  (`/api/files/<id>`), not the retrieved text itself. Exposing `POST /api/admin/assistant` to
  `homeowner` or public callers would let board-tier document text (financials, per-owner
  correspondence, legal/collections) surface verbatim in an answer even though the citation download
  would still correctly return 403 — a tier bypass through the answer body, not the download. See
  §2 of [ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md) for the constraint
  in full: relaxing the board-only gate requires per-caller retrieval filtering or separate per-tier
  indexes, plus a re-review of the PII-pseudonymization boundary described above.

## Automated safeguards

- **Dependabot** — dependency update PRs and security alerts (`.github/dependabot.yml`).
- **CI** — every push and PR runs format, type-check, unit tests, Worker/D1 integration tests
  (`test:server`), and build gates (`.github/workflows/build.yml`).

## Responsible disclosure

We will not pursue legal action against good-faith security research that respects residents'
privacy, avoids data destruction, and gives us reasonable time to remediate before public
disclosure.
