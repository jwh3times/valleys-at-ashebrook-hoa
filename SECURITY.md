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
- **`board` is never self-grantable.** A user's role is a column on the user record, changed only
  through the board-only admin API.
- **Homeowner verification is possession-based.** Sign-up is verified against the owner roster via
  a one-time code sent to the phone/email already on file (Resend / Twilio), gated by Cloudflare
  Turnstile.
- **Secrets never live in the repo.** Runtime secrets (auth, Resend, Twilio, Turnstile) are set as
  Cloudflare Worker secrets via `wrangler secret put` (see `SETUP.md`); only `PUBLIC_*` build-time
  variables are non-secret. `.env` files are git-ignored.
- **The roster is personal data.** Owner names, emails, and phone numbers live only in the D1
  database — never in committed files.

## Automated safeguards

- **Dependabot** — dependency update PRs and security alerts (`.github/dependabot.yml`).
- **CI** — every push and PR runs format, type-check, test, and build gates
  (`.github/workflows/build.yml`).

## Responsible disclosure

We will not pursue legal action against good-faith security research that respects residents'
privacy, avoids data destruction, and gives us reasonable time to remediate before public
disclosure.
