# Setup Guide — Valleys at Ashebrook HOA Website

This site is built with [Astro](https://astro.build) (public pages) + [React](https://react.dev)
(the admin panel and interactive islands) and runs entirely on **Cloudflare**:

- **Workers** — hosting + server-side rendering and API routes
- **D1** — the database (announcements, documents metadata, dues, site settings, accounts)
- **R2** — document file storage (governing docs, minutes, etc.)
- **KV** — session / rate-limit storage for authentication
- **Better Auth** — email/password accounts and roles (visitor / homeowner / board)

Plus a few external services: a public **Google Calendar** (community events), **Web3Forms**
(contact form email), an **email provider** and **Twilio** (one-time codes for homeowner
verification), and **Cloudflare Turnstile** (bot protection).

**Cost:** the Cloudflare free tier comfortably covers this site (D1, KV, R2 with no egress
fees, Workers). The only usage-based costs are Twilio SMS (~1¢ per text) and a small email
allowance; a custom domain is optional (~$10–15/yr). Follow the steps in order — you only do
this once.

---

## What you'll need

- A **Cloudflare account** (free).
- **Node.js** at the version in `.nvmrc` (run `nvm use`), only needed to build/deploy — not
  for day-to-day content editing.
- Accounts for: an **email provider** (these instructions use [Resend](https://resend.com)),
  **[Twilio](https://twilio.com)** (SMS), and **[Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)** (free).
- A **Google account** for the public HOA calendar (optional but recommended).
- About 45 minutes.

---

## 1. Install tools and log in

```bash
npm install
npx wrangler login     # opens a browser; sign in to the HOA Cloudflare account
```

## 2. Create the Cloudflare resources

Run each command once and copy the printed IDs into `wrangler.toml` where noted.

```bash
# D1 database — copy the "database_id" from the output into wrangler.toml
npx wrangler d1 create ashebrook-hoa

# KV namespace (auth sessions / rate limits) — copy the "id" into wrangler.toml
npx wrangler kv namespace create KV

# R2 bucket (document files) — bound as DOCS in wrangler.toml
npx wrangler r2 bucket create ashebrook-hoa-docs
```

In `wrangler.toml`, replace the placeholder values:

- `database_id = "local-dev-placeholder"` → your real D1 database ID
- `id = "local-dev-placeholder"` (under `[[kv_namespaces]]`) → your real KV namespace ID

## 3. Configure secrets and public values

Two kinds of configuration:

**a) Server secrets** — copy `.dev.vars.example` to `.dev.vars` (gitignored) for local
development, and set the same values as Cloudflare secrets for production
(`npx wrangler secret put NAME`, or the Cloudflare dashboard → Workers → your Worker → Settings → Variables).

| Secret | What it is |
| --- | --- |
| `BETTER_AUTH_SECRET` | A strong random string — generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Your site's URL (e.g. `https://valleys-at-ashebrook-hoa.jerryholland00.workers.dev`) |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Resend API key + the "from" address (verification / reset emails) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio credentials + sending number (SMS codes) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret (server-side verification) |

**b) Public build-time values** — set these `PUBLIC_*` values (they are safe to expose; Astro
inlines them into the client at build):

```
PUBLIC_TURNSTILE_SITE_KEY=...              # Turnstile site key (widget)
PUBLIC_GOOGLE_CALENDAR_ID=xxxx@group.calendar.google.com
PUBLIC_GOOGLE_CALENDAR_TIMEZONE=America/New_York
PUBLIC_WEB3FORMS_KEY=...                   # contact form (see step 8)
```

## 4. Apply the database migrations

```bash
npm run db:migrate:local     # local SQLite emulation for development
npm run db:migrate:remote    # the live Cloudflare D1 database
```

## 5. Import the owner roster

Homeowner sign-up is verified against the HOA owner roster (a one-time code is sent to the
phone/email already on file). Import your contact list:

```bash
npm run roster:import        # reads private/HOA_files/Ashebrook HOA Contact List.xlsx
                             # → writes private/roster-import.sql
npx wrangler d1 execute ashebrook-hoa --remote --file private/roster-import.sql
```

The board maintains the roster afterward from the `/admin` panel; ownership transfers mark the
old owner inactive (revoking access) and add the new owner.

## 6. Seed the first board account (one-time bootstrap)

Because no admin exists yet, the first board account can't be created through the normal
self-service flow — `seedBoard` writes the `role`/`emailVerified` fields directly in the
database. Run this once, right after the first deploy and the roster import.

Add a **short-lived** admin route to the Worker (remove it before the next deploy) that reads
`BOARD_EMAIL` / `BOARD_PASSWORD` / `BOARD_NAME` and calls `seedBoard`, guarded by a secret:

```ts
import { seedBoard } from '../../scripts/seed-board'; // adjust to where you place this route

// Temporary route — DELETE after first use.
export const POST = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? /* or import { env } from 'cloudflare:workers' */ null;
  if (request.headers.get('x-bootstrap-secret') !== env.BOOTSTRAP_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  const { BOARD_EMAIL, BOARD_PASSWORD, BOARD_NAME } = env;
  if (!BOARD_EMAIL || !BOARD_PASSWORD || !BOARD_NAME) {
    return new Response('Missing BOARD_EMAIL / BOARD_PASSWORD / BOARD_NAME', { status: 400 });
  }
  await seedBoard(env, BOARD_EMAIL, BOARD_PASSWORD, BOARD_NAME);
  return new Response(null, { status: 204 });
};
```

Set `BOARD_EMAIL`, `BOARD_PASSWORD`, `BOARD_NAME`, and `BOOTSTRAP_SECRET` as Cloudflare secrets
(and ensure the email secrets from step 3 are set, since sign-up sends a verification email),
POST once with the matching `x-bootstrap-secret` header, then **remove the route and redeploy**.
The board member can then sign in at `/login` and change their password via **Forgot password**.

## 7. Import the document archive

Load the HOA document archive into the library. Each file's visibility tier
(public / homeowner / board) and category are auto-proposed from its folder path.

```bash
npm run docs:import              # dry run → writes private/documents-manifest.json (review the tiers!)
# Review the manifest; sensitive folders default to the board tier (fail-safe). Adjust if needed.
npm run docs:import -- --commit  # uploads the files to R2 and inserts the documents rows into D1
```

The board can re-tier any document later from `/admin`.

## 8. Connect the community calendar (Google Calendar)

1. Open [Google Calendar](https://calendar.google.com) with the HOA account (or create a
   dedicated "Valleys at Ashebrook HOA" calendar).
2. Calendar **Settings** → select the calendar → **Access permissions** → check **Make
   available to public** ("See all event details").
3. Under **Integrate calendar**, copy the **Calendar ID** (looks like
   `xxxx@group.calendar.google.com`) into `PUBLIC_GOOGLE_CALENDAR_ID` (step 3b).

**Virtual meetings:** when you create an event, click **Add Google Meet video conferencing** —
the Meet link is saved in the event, so homeowners open it from the website's calendar and
click to join. No extra setup.

## 9. Connect the contact form (Web3Forms)

1. Go to <https://web3forms.com>, enter the HOA email address, and get a free **Access Key**
   (emailed to you). Submissions are delivered to that inbox.
2. Put it in `PUBLIC_WEB3FORMS_KEY` (step 3b).

## 10. Deploy

```bash
npm run build                                      # builds to dist/ with the Cloudflare adapter
npx wrangler deploy -c dist/server/wrangler.json   # deploy the Worker
```

The live Worker URL for this project is
`https://valleys-at-ashebrook-hoa.jerryholland00.workers.dev` (a custom domain can be
attached later — see Optional below). Set that URL as `BETTER_AUTH_URL` (step 3a) and
as `site` in `astro.config.mjs`, then redeploy.

> **Note:** the root `wrangler.toml` intentionally has no `main` field — the
> `@astrojs/cloudflare` adapter emits `dist/server/wrangler.json` with `main`, `assets`,
> and the bindings at build time, which is what you deploy with `-c`. Adding `main` to
> the root `wrangler.toml` breaks the build.

---

## Optional: custom domain

In the Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings** → **Domains &
Routes**, add your domain and follow the DNS steps (buy one from any registrar, ~$10–15/yr;
Cloudflare provides free SSL). Then update `BETTER_AUTH_URL` and `site` in
`astro.config.mjs`.

## Local development

```bash
npm run dev          # http://localhost:4321 (frontend)
```

For local work against the D1/R2/KV bindings, run the app through Wrangler
(`npx wrangler dev` after a build) so the bindings and `.dev.vars` secrets are
available. Migrations against the local database use `npm run db:migrate:local`.

## Day-to-day: how board members update the site

No setup needed — board members just:

1. Go to `https://your-site/admin`
2. Sign in with their email + password
3. Edit through the on-screen forms (announcements, documents + visibility tiers, dues, site
   settings) — changes appear on the site immediately.

## Where things live (quick reference)

| Thing | Where |
| --- | --- |
| Announcements, dues, site text | Cloudflare D1 (`announcements`, `settings`) |
| Documents (files) | Cloudflare R2 (`ashebrook-hoa-docs`) + metadata in D1 (`documents`) |
| Accounts, roles, roster, verification | Cloudflare D1 (Better Auth tables + `owners`, `user_property_links`) |
| Auth sessions / rate limits | Cloudflare KV |
| Calendar & Meet links | The HOA's public Google Calendar |
| Contact-form emails | Web3Forms → HOA inbox |
| Verification codes | Email provider (Resend) + Twilio SMS |
| Hosting | Cloudflare Workers |
