# Setup Guide — The Valleys at Ashebrook Residents

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
- A **Google account** for the public community calendar (optional but recommended).
- About 45 minutes.

---

## 1. Install tools and log in

```bash
npm install
npx wrangler login     # opens a browser; sign in to your Cloudflare account
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

Three kinds of configuration:

**a) Server secrets** — copy `.dev.vars.example` to `.dev.vars` (gitignored) for local
development, and set the same values as Cloudflare secrets for production
(`npx wrangler secret put NAME`, or the Cloudflare dashboard → Workers → your Worker → Settings → Variables).

| Secret | What it is |
| --- | --- |
| `BETTER_AUTH_SECRET` | A strong random string — generate with `openssl rand -base64 32` |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Resend API key + the "from" address (verification / reset emails) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio credentials + sending number (SMS codes) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret (server-side verification) |

**b) Public build-time values** — set these `PUBLIC_*` values (they are safe to expose; Astro
inlines them into the client at build):

```ini
PUBLIC_GOOGLE_CALENDAR_ID=xxxx@group.calendar.google.com
PUBLIC_GOOGLE_CALENDAR_TIMEZONE=America/New_York
```

> **Git auto-deploy note:** `PUBLIC_*` values are inlined **at build time**. If you deploy
> by connecting the repo to Cloudflare (Workers Builds), the build runs on Cloudflare where
> `.env` is not present, so set these as **build variables** in the Worker's Build settings —
> otherwise they ship empty.

**c) Non-secret runtime vars** — `BETTER_AUTH_URL` (your site's URL), `TURNSTILE_SITE_KEY`
(the public widget site key), and `WEB3FORMS_KEY` (the public contact form access key) are not
sensitive, so they live in `wrangler.toml` under `[vars]` rather than as secrets. Keeping
them in the repo makes it the source of truth, so Git
auto-deploys stay in sync (a dashboard-only value would be overwritten on the next deploy):

```toml
[vars]
BETTER_AUTH_URL = "https://ashebrookresidents.com"
TURNSTILE_SITE_KEY = "0x..."
WEB3FORMS_KEY = "..."
```

It must exactly match the hostname visitors use (protocol, apex vs `www`, no trailing slash) —
Better Auth uses it for cookies and for the links in verification / reset emails.

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

### Privacy — handling the owner roster

The roster (names, and the phone/email on file for each home) comes from the HOA's owner records
and is used for **one purpose only**: verifying that someone signing up actually lives at the home
they claim, by sending a one-time code to the contact already on file. It is never shown publicly
or used to message residents — the verification code is the only outbound message it drives.

- **Where it lives:** in this deployment's Cloudflare **D1** database. While the site is unofficial
  (see **Official mode** below), that database sits under the maintaining resident's own Cloudflare
  account — worth being transparent about if a neighbor asks.
- **Removal requests:** deactivate the person's owner record in `/admin` → **Roster** (this revokes
  any access tied to it). The admin UI only deactivates; to erase the stored phone/email entirely,
  delete the row directly, e.g.
  `npx wrangler d1 execute ashebrook-hoa --remote --command "DELETE FROM owners WHERE id = '<ownerId>'"`.
  A removed owner simply can't self-verify; the board can still grant access manually.
- **Backup & retention:** D1 **Time Travel** covers point-in-time restore for the past 30 days; for
  a durable backup run `npx wrangler d1 export ashebrook-hoa --remote --output backup.sql`
  periodically and store it securely — it contains the same PII as the roster, so treat it that way.

## 6. Seed the first board account (one-time bootstrap)

Because no admin exists yet, the first board account can't be created through the normal
self-service flow — `role`/`emailVerified` are written directly. The site ships a permanent,
fail-closed endpoint for exactly this: **`POST /api/bootstrap/board`**. It **self-disables the
moment any board account exists**, so there is no temporary route to add and remember to remove
(the previous procedure's biggest risk — a forgotten route is a standing role-escalation
backdoor). Run this once, right after the first deploy and the roster import.

1. Set these Cloudflare secrets (in addition to the email secrets from step 3, since sign-up
   sends a verification email):

   ```bash
   npx wrangler secret put BOOTSTRAP_SECRET   # a long random string you choose
   npx wrangler secret put BOARD_EMAIL
   npx wrangler secret put BOARD_PASSWORD     # 10+ characters
   npx wrangler secret put BOARD_NAME
   ```

2. POST once with the matching secret header:

   ```bash
   curl -X POST https://<your-site>/api/bootstrap/board \
     -H "x-bootstrap-secret: <the BOOTSTRAP_SECRET you set>"
   ```

   `204` = the board account was created. `410` = a board account already exists (the endpoint
   has self-disabled); `403` = the secret is missing or wrong; `400` = a `BOARD_*` secret is unset.

3. (Recommended) Delete the now-unneeded bootstrap secrets so they aren't left lying around:

   ```bash
   npx wrangler secret delete BOOTSTRAP_SECRET
   npx wrangler secret delete BOARD_PASSWORD
   ```

The board member can then sign in at `/login`. To change the bootstrap password, use
**Forgot password** and complete the emailed reset link on `/reset-password`.
(The same logic is exported as `seedBoard` from `scripts/seed-board.ts` for CLI use, but the
endpoint above is the supported path.)

## 7. Import the document archive

Load the HOA document archive into the library. Each file's visibility tier
(public / homeowner / board) and category are auto-proposed from its folder path.

```bash
npm run docs:import              # dry run → writes private/documents-manifest.json (review the tiers!)
# Review the manifest; sensitive folders default to the board tier (fail-safe). Adjust if needed.
npm run docs:import -- --commit  # uploads the files to R2 and inserts the documents rows into D1
```

The board can re-tier any document later from `/admin`.

### Deduplicating documents

After importing the archive, run a dry duplicate scan:

```bash
npm run docs:dedupe
```

Review `private/dedupe-report.json`. If the same-tier exact duplicate plan looks correct, commit the
cleanup:

```bash
npm run docs:dedupe -- --commit
```

The commit step writes `content_hash` values to D1 and deletes only same-tier exact duplicate
extras from R2 + D1. Cross-tier exact groups and near-duplicate groups are left for board review in
`/admin` -> **Duplicates**.

## 8. Connect the community calendar (Google Calendar)

1. Open [Google Calendar](https://calendar.google.com) with your Google account (or
   create a dedicated "Valleys at Ashebrook Residents" calendar).
2. Calendar **Settings** → select the calendar → **Access permissions** → check **Make
   available to public** ("See all event details").
3. Under **Integrate calendar**, copy the **Calendar ID** (looks like
   `xxxx@group.calendar.google.com`) into `PUBLIC_GOOGLE_CALENDAR_ID` (step 3b).

**Virtual meetings:** when you create an event, click **Add Google Meet video conferencing** —
the Meet link is saved in the event, so homeowners open it from the website's calendar and
click to join. No extra setup.

## 9. Connect the contact form (Web3Forms)

1. Go to <https://web3forms.com>, enter your contact email address, and get a free
   **Access Key** (emailed to you). Submissions are delivered to that inbox.
2. Put it in `WEB3FORMS_KEY` in `wrangler.toml` (step 3c).

## 10. Deploy

```bash
npm run build                                      # builds to dist/ with the Cloudflare adapter
npx wrangler deploy -c dist/server/wrangler.json   # deploy the Worker
```

The live Worker URL for this project is
`https://valleys-at-ashebrook-hoa.jerryholland00.workers.dev` (a custom domain can be
attached later — see Optional below). Set that URL as `BETTER_AUTH_URL` in `wrangler.toml`
(step 3c) and as `site` in `astro.config.mjs`, then redeploy.

> **Note:** the root `wrangler.toml` intentionally has no `main` field — the
> `@astrojs/cloudflare` adapter emits `dist/server/wrangler.json` with `main`, `assets`,
> and the bindings at build time, which is what you deploy with `-c`. Adding `main` to
> the root `wrangler.toml` breaks the build.

---

## Optional: custom domain

In the Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings** → **Domains &
Routes**, add your domain and follow the DNS steps (buy one from any registrar, ~$10–15/yr;
Cloudflare provides free SSL). Then update `BETTER_AUTH_URL` in `wrangler.toml` (`[vars]`)
and `site` in `astro.config.mjs`, and redeploy.

### Security headers

The Worker sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`, and an **enforced** Content-Security-Policy on every
response. Two settings live at the Cloudflare **zone** level, not in code:

- **HSTS:** enable in the dashboard → SSL/TLS → Edge Certificates → HTTP Strict
  Transport Security (recommend `max-age=15552000`, includeSubDomains once you've
  confirmed every subdomain is HTTPS).
- **CSP is enforced.** The directive list in `src/middleware.ts` allows exactly the
  third-party resources the site uses (Google Fonts, the Google Calendar embed,
  Turnstile, and Web3Forms) plus the Cloudflare Web Analytics beacon
  (`static.cloudflareinsights.com`), which Cloudflare's edge injects into the deployed
  HTML automatically. If you add a new external resource — an embed,
  analytics, a font host — add its host to the matching directive, or it will be
  blocked. To debug a blocked resource, temporarily swap the header name to
  `Content-Security-Policy-Report-Only`, reproduce it while watching the browser
  console, fix the directive, then swap the name back.

## Local development

```bash
npm run dev          # http://localhost:4321 (frontend)
```

For local work against the D1/R2/KV bindings, run the app through Wrangler
(`npx wrangler dev` after a build) so the bindings and `.dev.vars` secrets are
available. Migrations against the local database use `npm run db:migrate:local`.

`http://localhost:4321` is a trusted auth origin, so sign-in works locally even
though `BETTER_AUTH_URL` points at the production URL. If you run the dev server
on a different host/port, add that origin to `trustedOrigins` in
`src/server/auth/index.ts`.

## Day-to-day: how board members update the site

No setup needed — board members just:

1. Go to `https://your-site/admin`
2. Sign in with their email + password
3. Edit through the on-screen forms (announcements, documents + visibility tiers, dues, site
   settings) — changes appear on the site immediately.

## Official mode

The public site defaults to **unofficial mode**: it presents as an independent,
resident-run information hub — the header shows a "Residents" tag instead of "Homeowners
Association", the Dues nav link and dues/board-specific copy are hidden, and the footer
(plus a dedicated `/about` page) carries a "not affiliated with the HOA" disclaimer.

If the HOA board formally adopts the site, a board member can flip it on from the admin
panel: `/admin` → **Site Settings** → check **Official mode** → **Save**. The change
takes effect for every visitor immediately — no redeploy or rebuild needed, since the
flag is read from D1 (the `settings` table) on every request. Official mode restores the
"Homeowners Association" tag, the Dues nav link, "Pay Dues" / "Contact the Board" copy,
and removes the disclaimer. Unchecking the box and saving reverts to unofficial mode just
as quickly.

## Where things live (quick reference)

| Thing | Where |
| --- | --- |
| Announcements, dues, site text | Cloudflare D1 (`announcements`, `settings`) |
| Documents (files) | Cloudflare R2 (`ashebrook-hoa-docs`) + metadata in D1 (`documents`) |
| Accounts, roles, roster, verification | Cloudflare D1 (Better Auth tables + `owners`, `user_property_links`) |
| Auth sessions / rate limits | Cloudflare KV |
| Calendar & Meet links | The site's public Google Calendar |
| Contact-form emails | Web3Forms → your inbox |
| Verification codes | Email provider (Resend) + Twilio SMS |
| Hosting | Cloudflare Workers |
