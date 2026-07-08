# The Valleys at Ashebrook Residents

An independent, resident-run website for the Valleys at Ashebrook neighborhood — **not**
the official Valleys at Ashebrook HOA site. It's built and maintained by a resident as a
convenience for neighbors. An admin-toggleable **official mode** (off by default) lets a
board that wants to adopt the site turn on HOA branding and dues/board copy; while it's
off, the site presents as an unofficial resident hub with a "not affiliated with the
HOA" disclaimer (see `/about`) and hides dues/board-only surfaces.

It provides:

- 📣 **Announcements** — community news
- 📅 **Community calendar** — meetings and events via Google Calendar,
  with Google Meet links for virtual meetings
- 📄 **Governing documents** — bylaws, CC&Rs, minutes, and forms, with board-side
  duplicate detection and cleanup tools
- 💳 **Dues & payments** — annual dues amount and payment options (shown in official
  mode)
- ✉️ **Contact form** — reaches the resident who maintains the site (or the board, in
  official mode)
- 🔐 **Admin panel** — a built-in, password-protected admin panel (`/admin`) for site
  administrators (the `board` role) to manage everything without touching code,
  including the official-mode toggle

Homeowners can create accounts (verified against the owner roster via a one-time code)
to access homeowner-only content. Content visibility has three tiers: public, homeowner,
and board.

## Tech stack

| Concern | Choice | Cost |
| --- | --- | --- |
| Framework | [Astro](https://astro.build) (SSR) + React | Free |
| Hosting / runtime | [Cloudflare Workers](https://workers.cloudflare.com) | Free tier |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite, Drizzle ORM) | Free tier |
| File storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) | Free tier |
| Sessions | [Cloudflare KV](https://developers.cloudflare.com/kv/) | Free tier |
| Auth | [Better Auth](https://www.better-auth.com) (email/password) | Free |
| Verification email | [Resend](https://resend.com) | Free tier |
| Verification SMS | [Twilio](https://twilio.com) | ~1¢/text |
| Bot protection | [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) | Free |
| Calendar / Meet | Public Google Calendar | Free |
| Contact email | [Web3Forms](https://web3forms.com) → Gmail | Free |

The whole site runs on free tiers with **no recurring cost** (Twilio SMS is ~1¢ per
text; a custom domain is optional, ~$10–15/yr).

## Getting started

See **[SETUP.md](./SETUP.md)** for the complete, step-by-step setup and
deployment guide.

This project targets the Node version in [`.nvmrc`](./.nvmrc) (run `nvm use`).

Quick commands:

```bash
npm install        # install dependencies
npm run dev        # local dev server at http://localhost:4321
npm run build      # build the SSR Worker to dist/
npm test           # run the Vitest spec suite
npm run check      # Astro + TypeScript type check
npm run format     # format all files with Prettier
npm run docs:dedupe # dry-run document duplicate report
npm run deploy     # build + deploy to Cloudflare Workers
```

## Testing & formatting

- **Tests:** [Vitest](https://vitest.dev) + [Testing Library](https://testing-library.com).
  Component specs live next to each component (`*.test.tsx`); unit tests live under
  `test/unit/`; Worker/D1 integration tests live under `test/server/` and run via
  `npm run test:server`. Run `npm test` (or `npm run test:watch`).
- **Formatting:** [Prettier](https://prettier.io) with `prettier-plugin-astro`.
  Run `npm run format`; CI enforces `npm run format:check`.
- **CI:** `.github/workflows/build.yml` runs format check, type check, tests,
  and build on every push and pull request. CodeQL code scanning runs via GitHub's
  default setup (configured in repo Settings — there is intentionally no CodeQL
  workflow file in the repo). Deploys from `main` are handled by Cloudflare Workers
  Builds, not a GitHub deploy workflow.

## Project layout

```
src/
  pages/              Astro pages + API routes (SSR)
    api/              Same-origin API endpoints (content, admin, auth, verify, files)
  layouts/            Shared page shell
  components/         Header/Footer + React islands
    admin/            The board admin app
  lib/                Client helpers (content.ts, admin.ts, site.ts, format.ts, types.ts, auth-client.ts)
  server/             Server-only code
    auth/             Better Auth config, Resend + Twilio senders
    authz/            getAuthContext, requireRole, requireBoard, Turnstile check
    content/          Visibility logic (tierAllows / visibleTiers) + read helpers
    db/               Drizzle schema, client (getDb), migrations/
    roster/           Owner roster helpers
    verification/     One-time code flow
  styles/             Global CSS
wrangler.toml         Cloudflare bindings (D1, KV, R2)
drizzle.config.ts     Drizzle ORM config
src/server/db/migrations/   D1 migration files
```

## How content is edited

Board members go to `/admin`, sign in with their email + password (Better Auth), and
manage announcements, documents, duplicate document cleanup, dues, and site text through on-screen forms. Board
membership itself is also managed in the admin app, under **Board members**: a board
member can promote another account to `board` and demote a board member (the last
remaining board member can't be demoted), which supports handing the site off to a new
board over time. A board member can't escalate their own access beyond `board`, and
the Better Auth admin plugin's impersonation/ban/set-role endpoints are not granted to
board sessions. The *first* board account is bootstrapped through a permanent, fail-closed
`POST /api/bootstrap/board` endpoint that self-disables once any board account exists — see
SETUP.md §6.

## Contributing & support

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and local
checks, and [CLAUDE.md](./CLAUDE.md) for the architecture and conventions. By participating you
agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). For help and bug reports, see
[SUPPORT.md](./SUPPORT.md); report vulnerabilities privately per [SECURITY.md](./SECURITY.md).
Shipped changes are tracked in the [changelog](./CHANGELOG.md).
