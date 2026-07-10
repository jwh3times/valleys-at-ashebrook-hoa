# Setup Guide — The Valleys at Ashebrook Residents

This site is an independent, resident-run information hub for the Valleys at Ashebrook
neighborhood. It is **not** the official HOA website unless the HOA board formally adopts it and
turns on official mode in the admin panel.

The app is built with [Astro](https://astro.build) + [React](https://react.dev) and runs on
Cloudflare:

- **Workers** — SSR, API routes, and scheduled maintenance
- **D1** — relational data: content metadata, accounts, roles, roster, verification state
- **R2** — document files
- **KV** — session/rate-limit storage required by the Cloudflare adapter and verification flow
- **Better Auth** — email/password accounts and roles

External services are optional but expected in production: an email provider such as Resend,
Twilio for SMS verification codes, Cloudflare Turnstile, a public Google Calendar, and Web3Forms
for the contact form.

Production operators should keep site-specific resource names, roster files, bootstrap secrets,
backup commands, and resident-data handling runbooks in a private operations document, not in this
public repo.

---

## What You'll Need

- A Cloudflare account.
- Node.js at the version in `.nvmrc` (`nvm use`).
- Provider accounts for email delivery, SMS delivery, Turnstile, Web3Forms, and Google Calendar.
- A private owner roster source if homeowner verification will be enabled.

---

## 1. Install Tools

```bash
npm install
npx wrangler login
```

## 2. Create Cloudflare Resources

Create one D1 database, one KV namespace for app/auth support, one KV namespace named `SESSION` for
Astro sessions, and one R2 bucket for documents.

```bash
npx wrangler d1 create <database-name>
npx wrangler kv namespace create KV
npx wrangler kv namespace create SESSION
npx wrangler r2 bucket create <documents-bucket-name>
```

Copy the printed IDs into `wrangler.toml`. Resource names in this repository are examples; use the
names for your deployment.

## 3. Configure Secrets and Public Values

Server secrets are set locally in `.dev.vars` and in production with Cloudflare Worker secrets.
Do not commit real values.

| Secret                                                            | Purpose                                           |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                              | Better Auth secret and verification-code HMAC key |
| `EMAIL_API_KEY`, `EMAIL_FROM`                                     | Account verification and password-reset email     |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`          | SMS homeowner-verification codes                  |
| `TURNSTILE_SECRET_KEY`                                            | Server-side Turnstile verification                |
| `BOOTSTRAP_SECRET`, `BOARD_EMAIL`, `BOARD_PASSWORD`, `BOARD_NAME` | One-time first-board bootstrap configuration      |

Public build-time values are safe to expose and are inlined by Astro:

```ini
PUBLIC_GOOGLE_CALENDAR_ID=xxxx@group.calendar.google.com
PUBLIC_GOOGLE_CALENDAR_TIMEZONE=America/New_York
```

Non-secret runtime values live in `wrangler.toml` under `[vars]`:

```toml
BETTER_AUTH_URL = "https://example.com"
TURNSTILE_SITE_KEY = "0x..."
WEB3FORMS_KEY = "..."
```

Set `BETTER_AUTH_URL` to the exact production origin visitors use.

## 4. Apply Migrations

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Before applying migrations that add referential integrity to an existing remote database, run the
orphan audit in your private operations workflow and confirm every count is zero.

## 5. Import the Owner Roster

Homeowner verification uses the owner roster only to send one-time codes to contacts already on
file. Keep roster files and generated import SQL under `private/`.

```bash
npm run roster:import
# Review the generated private SQL, then apply it with wrangler d1 execute.
```

The board maintains roster records afterward from `/admin` -> **Roster**. Public docs should not
contain resident data, derived roster files, or deployment-specific deletion/export commands.

### Privacy — Handling the Owner Roster

The roster contains personal data and is used only for owner verification. It is not shown publicly
and should not be committed. Production operators should document removal, erasure, backup, and
retention procedures privately because those procedures depend on the deployment owner and data
handling process.

## 6. Seed the First Board Account

The first board account is created through `POST /api/bootstrap/board`. The endpoint is fail-closed:
it requires bootstrap configuration and self-disables once any board account exists.

Keep the exact bootstrap command and any temporary bootstrap secrets in private operations notes.
After the first board account exists, board membership is managed from `/admin` -> **Board
members**.

## 7. Import Documents

Document archive files and generated manifests belong under `private/`.

```bash
npm run docs:import
# Review the private manifest and proposed visibility tiers.
npm run docs:import -- --commit
```

Uploaded documents are stored in R2 with D1 metadata. Visibility is enforced server-side for both
document lists and downloads.

### Deduplicating Documents

```bash
npm run docs:dedupe
# Review the private duplicate report.
npm run docs:dedupe -- --commit
```

The cleanup script auto-resolves only same-tier exact duplicates. Cross-tier exact groups and
near-duplicate groups are left for board review in `/admin` -> **Duplicates**.

## 8. AI Document Assistant (optional)

The admin panel's **Assistant** tab lets a board member ask natural-language questions about the
document library and get a streamed, cited answer (Cloudflare AI Search + Claude). It's optional —
the rest of the site works without it — and only useful once documents have real content indexed.

1. In the Cloudflare dashboard, create an **AI Search** instance pointed at the same R2 bucket used
   for documents (`ashebrook-hoa-docs` in this repo's `wrangler.toml`). AI Search only indexes files
   up to 4 MB and does not index `.xlsx` spreadsheets — large or spreadsheet documents won't be
   searchable by the assistant even though they still work normally in the document library.
2. Set the instance name in `wrangler.toml` under `[vars]` as `AI_SEARCH_INSTANCE` (this repo uses
   `ashebrook-ai-docs-search`; use whatever name you gave the instance in step 1).
3. Set the generation secret: `wrangler secret put ANTHROPIC_API_KEY`.
4. The assistant only has something to answer from once documents are imported to R2 (see §7) and
   AI Search has finished indexing them — a fresh deployment with an empty or newly created bucket
   will return "could not find it in the documents" for everything until content exists.
5. Before any document excerpt, the question, or prior chat turns are sent to Anthropic, known
   resident PII is pseudonymized: roster names (including individual first/last name tokens, so a
   standalone first name or surname is also caught) and addresses are matched against the current
   roster and swapped for realistic, consistent placeholder values, and any email address or phone
   number anywhere in the text is swapped the same way — the real values are restored only in the
   answer streamed back to the board member's browser, and document titles are never sent (citations
   use index labels, resolved back to real documents server-side). This is **best-effort**, not a
   guarantee: it does not catch non-resident names, free text that doesn't match a roster value, or
   narrow edge cases such as a roster value whose closing abbreviation period is glued directly to
   the next word with no separating space.

## 9. Connect Calendar and Contact Services

- Google Calendar: make the community calendar public and set `PUBLIC_GOOGLE_CALENDAR_ID`.
- Web3Forms: create an access key and set `WEB3FORMS_KEY` in `wrangler.toml`.

## 10. Deploy

Production deploys from `main` are handled by Cloudflare Workers Builds. GitHub Actions is the
verification gate for formatting, type checks, tests, and build.

Manual deploys use:

```bash
npm run build
npx wrangler deploy -c dist/server/wrangler.json
```

The root `wrangler.toml` uses `main = "src/worker.ts"` so the custom Worker entrypoint can handle
Astro SSR requests and the scheduled cleanup trigger.

## Scheduled Maintenance

Wrangler config includes a daily cron trigger. It runs `cleanupVerificationState`, which keeps 30
days of consumed/expired property-verification rows and resolved manual-approval rows. Pending
manual approvals are retained.

## Security Headers

The Worker sets baseline security headers, including an enforced Content-Security-Policy. HSTS is
not yet enabled by this repository; it must be enabled separately at the Cloudflare zone level after
confirming HTTPS is stable for the production domain and any relevant subdomains.

## Local Development

```bash
npm run dev
```

For local work against Cloudflare bindings, use Wrangler after a build so D1/R2/KV bindings and
`.dev.vars` secrets are available.

`http://localhost:4321` is a trusted auth origin. If you use a different local origin, add it to
`trustedOrigins` in the Better Auth config.

## Day-to-Day Content Updates

Board members use `/admin` to manage announcements, documents, duplicate cleanup, dues, site
settings, roster records, homeowner access, and board membership. Changes are written to D1/R2 and
appear on the site without a code deploy.

## Official Mode

The public site defaults to unofficial resident mode. In this mode it presents as an independent,
resident-run information hub, shows the disclaimer, and hides official-HOA surfaces such as dues
navigation.

If the HOA board formally adopts the site, a board member can enable official mode from `/admin` ->
**Site Settings**. The change is stored in D1 and takes effect on the next SSR page request.

## Public Architecture

See [docs/architecture.md](./docs/architecture.md) for a public architecture overview and
[docs/adr/](./docs/adr/) for durable architecture decisions.
