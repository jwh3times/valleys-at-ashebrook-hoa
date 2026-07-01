# Valleys at Ashebrook HOA

The official website for the Valleys at Ashebrook Homeowners Association.

It provides:

- 📣 **Announcements** — community news posted by the board
- 📅 **Community calendar** — board meetings and events via Google Calendar,
  with Google Meet links for virtual meetings
- 📄 **Governing documents** — bylaws, CC&Rs, minutes, and forms (PDF downloads)
- 💳 **Dues & payments** — annual dues amount and payment options
- ✉️ **Contact form** — homeowners can email the board
- 🔐 **Board admin** — a built-in, password-protected admin panel (`/admin`) for
  board members to manage everything without touching code

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
  and build on every push and pull request, plus CodeQL.

## Project layout

```
src/
  pages/              Astro pages + API routes (SSR)
    api/              Same-origin API endpoints (content, admin, auth, verify, files)
  layouts/            Shared page shell
  components/         Header/Footer + React islands
    admin/            The board admin app
  lib/                Client helpers (content.ts, admin.ts, types.ts, auth-client.ts)
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
manage announcements, documents, dues, and site text through on-screen forms. The
`board` role is set directly in the database — it is never self-grantable through the
app. See SETUP.md for how to seed the first board member.
