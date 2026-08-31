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
npm run types:worker
npx wrangler login
```

`worker-configuration.d.ts` is generated from `wrangler.toml` plus the public variable names in
`.env.example` and is committed to the repository. Regenerate it after changing either file;
`npm run types:worker:check` verifies that the committed declarations are current without writing
them.

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
Do not commit real values. If you already have access to this deployment's private operations
companion repository, `npm run bootstrap:env` (see
[Workstation bootstrap](./docs/workstation-bootstrap.md)) materializes `.env`/`.dev.vars` for the
current worktree from 1Password instead of copying these values by hand, and
`npm run secrets:put -- <NAME>` deploys a production secret the same way — value-free, via stdin
and the operator token from 1Password. Both report variable names only.

| Secret                                                   | Purpose                                              |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                     | Better Auth secret and verification-code HMAC key    |
| `EMAIL_API_KEY`, `EMAIL_FROM`                            | Account verification and password-reset email        |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS homeowner-verification codes                     |
| `TURNSTILE_SECRET_KEY`                                   | Server-side Turnstile verification                   |
| `BOOTSTRAP_SECRET`                                       | One-time first-System-Administrator bootstrap secret |

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

**Merging to `main` does NOT apply migrations to production.** Deploys never run D1 migrations —
this was verified on 2026-08-17, when daily deploys succeeded while five committed migrations sat
unapplied. Migrations are applied by hand, for the local database and for production alike; the
command is safe to re-run, since Wrangler tracks applied files in D1 and skips them:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Because merged code can run ahead of the production schema, check parity — the following must list
nothing unapplied — before trusting schema-dependent code in production, and always before a
maintenance freeze or backfill:

```bash
npx wrangler d1 migrations list DATABASE --remote
```

Before applying migrations that add referential integrity to an existing remote database, run the
orphan audit in your private operations workflow and confirm every count is zero.

**Migrations `0028` and `0029` are not safe in either order.** Every migration before them was
written so merged code works against the schema whether or not the migration has run yet; these two
break that, since they rename columns the deployed code reads and writes.

- `0028` renames `candidates.board_person_id` to `candidates.person_id` and repoints several
  meeting/election identity columns off the legacy `board_people` onto the party roster.
- `0029` renames `member_attendance.represented_by_owner_id`, `member_votes.cast_by_owner_id`,
  `ballots.cast_by_owner_id`, and `proxies.grantor_owner_id`/`holder_owner_id` to their
  `*_person_id` forms, repointing them off the legacy `owners` table onto the party roster.

Run `npm run db:migrate:remote` for either one before or together with deploying the code that
ships with it — not on the otherwise-safe any-time-before-the-next-freeze schedule above. Skipping
that ordering breaks the admin meeting-record people picker and the candidate-link write path for
`0028`, and the member attendance, member vote, ballot, and proxy surfaces for `0029`, until the
migration runs.

**Pull `main` before you apply.** `wrangler d1 migrations apply` reads migrations from your LOCAL
disk, so a checkout that predates the merge has nothing to offer and reports:

```
✅ No migrations to apply!
```

That is true of the disk and indistinguishable from a database that is already current — while the
merged code is deployed and running against the old schema. It happened with `0029` on 2026-08-21.
`npm run db:migrate:remote` now runs `scripts/check-migrations-current.ts` first and refuses when
the checkout is behind `origin/main`, naming the migrations it lacks; set `MIGRATE_ALLOW_BEHIND=1`
to apply anyway (a deliberate older tree, or an unreachable network). Belt and braces, check npm's
banner: the version it prints is your checkout's, and it should match the release the merge minted.

Afterwards, confirm the schema is sound rather than assuming it:

```bash
npx wrangler d1 migrations list DATABASE --remote   # nothing unapplied
npm run verify:invariants -- --remote               # 17/17, incl. PRAGMA foreign_key_check
```

The invariant run is what catches a botched table rebuild — a row left pointing at a parent that no
longer exists — which a migration that rebuilds tables under `PRAGMA defer_foreign_keys` can
otherwise leave behind silently.

## 5. Import the Owner Roster

Homeowner verification uses the owner roster only to send one-time codes to contacts already on
file. Keep roster files and generated import SQL under the configured private root. Operator tools
read `ASHEBROOK_PRIVATE_ROOT`; unset or blank preserves the existing `private/` default, while a
relative value resolves from the public repository root and an absolute value may point at an
approved external records working directory. See
[Workstation bootstrap](./docs/workstation-bootstrap.md).

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

## 6. Bootstrap the First System Administrator

The first System Administrator account is created through `POST /api/bootstrap/board`. The
endpoint is permanently fail-closed and self-disables (`410`) the moment its one-time
`system_admin_bootstrap` record is written — not "once a board account exists" (an account can
also be promoted board later from `/admin`), but "has bootstrap itself already run."

Bootstrap **links** an already-signed-in account to an already-recorded roster Person; it does not
create a new account from board credentials.

1. Sign up a normal account on the site (email/password) and sign in with it.
2. Make sure the Person you intend to bootstrap already exists in the party roster. On a fresh
   deploy this means running the roster import from §5 and then the roster backfill:
   ```bash
   npm run roster:backfill -- --local --write --operator=<accountId>
   # drop --local for the remote database once you've reviewed the dry-run output
   ```
   Look up the target Person's id if you don't already have it, e.g.:
   ```bash
   npx wrangler d1 execute <database-name> --command \
     "SELECT party_id, full_name FROM people WHERE full_name LIKE '%Name%'"
   ```
3. While signed in as the account from step 1, call the endpoint with the bootstrap secret and
   that Person's id:
   ```bash
   curl -X POST https://<your-domain>/api/bootstrap/board \
     -H "x-bootstrap-secret: <BOOTSTRAP_SECRET>" \
     -H "content-type: application/json" \
     --cookie "<your session cookie>" \
     -d '{"personId":"<party_id from step 2>"}'
   ```
   The session cookie is `httpOnly`, so it has to be copied out of the browser's devtools by
   hand — easy to mangle, and a mangled value looks exactly like an auth failure (`401`). The
   reliable alternative is to send the request from the site's own devtools **Console**, where a
   same-origin `fetch` attaches the cookie and a correct `Origin` automatically:
   ```javascript
   await fetch('/api/bootstrap/board', {
     method: 'POST',
     headers: {
       'x-bootstrap-secret': '<BOOTSTRAP_SECRET>',
       'content-type': 'application/json',
     },
     body: JSON.stringify({ personId: '<party_id from step 2>' }),
   }).then((r) => r.status); // expect 204
   ```
   Delete the secret afterwards (`npx wrangler secret delete BOOTSTRAP_SECRET`). Note that in
   PowerShell `curl` is an alias for `Invoke-WebRequest`; use `curl.exe` if you take the curl
   route there.

A successful call links the account to that Person, records a `bootstrap` Person Verification,
grants `system_admin` Access, and mirrors `users.role = 'board'` so the admin panel works
immediately. Keep the exact bootstrap command, secret, and session details in private operations
notes. After the first account exists, board and System Administrator access are managed from
`/admin`.

This section describes a **fresh** deployment. On the existing production deployment bootstrap has
already run — it was step 4 of the ADR 0022 phase 3f flip on 2026-08-18 — so the endpoint there is
permanently disabled and answers `410`. Additional System Administrators are granted from the admin
**Access** panel by an existing one; the last live `system_admin` grant cannot be revoked.

## 7. Import Documents

Document archive files and generated manifests belong under the configured private root described
in §5. They may live outside the public checkout through `ASHEBROOK_PRIVATE_ROOT`; leaving it unset
continues to use `private/`.

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

### Importing the RAG/Download Corpus

The document library and the AI Search index are two R2 representations of the same corpus, keyed
by uuid (see [ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md)):
human-readable originals under `documents/<uuid>/<filename>` (what residents download) and Markdown
twins under `rag/<uuid>.md` (what AI Search indexes). `scripts/import-corpus.ts` loads both from a
private manifest as a **clean replace** — it is operator-run, not part of the app's normal write
path.

```bash
npm run corpus:import
# Dry run: review the manifest and planned R2/D1 writes.
npm run corpus:import -- --commit --wipe
# Destructive: wipes the current documents/R2 corpus, then loads it fresh.
```

A full run loads 444 human-readable documents and 429 Markdown twins (some human files have no
searchable twin, e.g. formats AI Search can't usefully index). After a commit, follow §8 step 4 to
trigger an AI Search sync and confirm the indexed count lands around 429.

### OCR scanned uploads (make "Not searchable" PDFs searchable)

Scanned/image-only PDFs upload fine but are flagged "Not searchable" (no text to
index). To OCR them into the search index, set `CLOUDFLARE_ACCOUNT_ID` and a
`CLOUDFLARE_API_TOKEN` with **Workers AI Run**, **R2 object read/write**, and
**D1 read/write** permissions (the script's wrangler R2/D1 calls inherit this
token, so a Workers-AI-only token would 403 those steps), then run:

- `npm run ocr:scanned` — lists the unsupported-PDF candidates (no changes).
- `npm run ocr:scanned -- --sample` — OCRs one document and prints the Markdown
  so you can judge quality (no changes).
- `npm run ocr:scanned -- --commit` — OCRs and writes each usable twin, flipping
  `rag_status` to `ok`. Add `--limit=N` to do a small batch first.

OCR runs on Cloudflare Workers AI (document content stays within Cloudflare).
Results become assistant-searchable at the next AI Search sync (default ≤6h). A
scan with no readable text is left "Not searchable" rather than indexed empty.

## 8. AI Document Assistant (optional)

The admin panel's **Assistant** tab lets a board member ask natural-language questions about the
document library and get a streamed, cited answer (Cloudflare AI Search + Claude). It's optional —
the rest of the site works without it — and only useful once documents have real content indexed.

1. In the Cloudflare dashboard, create an **AI Search** instance pointed at the same R2 bucket used
   for documents (`ashebrook-hoa-docs` in this repo's `wrangler.toml`). **Scope the instance's R2
   data source to the `rag/` folder only** (not the bucket root) — AI Search must index the
   `rag/<uuid>.md` Markdown twins, never the human-readable originals under `documents/<uuid>/…`
   (see [ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md)). AI Search only
   indexes files up to 4 MB and does not index `.xlsx` spreadsheets, but that no longer matters for
   the resident-facing library: the `rag/` twins are plain Markdown, so retrieval quality no longer
   depends on the original file's format or size.
2. Set the instance name in `wrangler.toml` under `[vars]` as `AI_SEARCH_INSTANCE` (this repo uses
   `ashebrook-ai-docs-search`; use whatever name you gave the instance in step 1).
3. Set the generation secret: `wrangler secret put ANTHROPIC_API_KEY`.
4. Load or refresh the corpus with `scripts/import-corpus.ts` (see "Importing the RAG/Download
   Corpus" under §7), then trigger a sync on the AI Search instance from the Cloudflare dashboard and
   confirm it reports roughly **429 indexed objects** — the count of `rag/<uuid>.md` twins, not the
   larger human-file count. A fresh deployment with an empty or newly created bucket will return
   "could not find it in the documents" for everything until the corpus is imported and indexed.
   After this initial load, board uploads made through the admin panel build their own
   `rag/<uuid>.md` twin automatically and become assistant-searchable at the next AI Search sync
   (default sync interval is ≤6h, not instant). An upload that can't be converted to searchable text
   (a scan or an unsupported format) still stores and downloads normally, but shows a
   "Not searchable" badge in the admin Documents panel.
5. Before any document excerpt, the question, or prior chat turns are sent to Anthropic, known
   resident PII is pseudonymized: roster names (including individual first/last name tokens, so a
   standalone first name or surname is also caught, except tokens that are common English words,
   which are left intact so ordinary document text isn't garbled) and addresses are matched against
   the current roster and swapped for realistic, consistent placeholder values. Any email address
   found anywhere in the text is pseudonymized the same way; roster phone numbers are pseudonymized
   in any format, and any number written in a standard phone format is pseudonymized whether or not
   it matches the roster, but bare/long numeric IDs are left alone. Document titles are
   pseudonymized the same way and sent as part of each excerpt's label. The real values are restored
   only in the answer streamed back to the board member's browser, and citations use index labels
   resolved back to real documents server-side. This is **best-effort**, not a guarantee: it does
   not catch non-resident names, free text that doesn't match a roster value, or narrow edge cases
   such as a roster value whose closing abbreviation period is glued directly to the next word with
   no separating space.

## 9. Connect Calendar and Contact Services

- Google Calendar: make the community calendar public and set `PUBLIC_GOOGLE_CALENDAR_ID`.
- Web3Forms: create an access key and set `WEB3FORMS_KEY` in `wrangler.toml`.

## 10. Deploy

Production deploys from `main` are handled by Cloudflare Workers Builds. GitHub Actions is the
verification gate for formatting, type checks, tests, build, and a dry-run validation of the
adapter-generated Wrangler deployment config.

Manual deploys use:

```bash
npm run types:worker:check
npm run build
npm run deploy:check
npx wrangler deploy -c dist/server/wrangler.json
```

The root `wrangler.toml` uses `main = "src/worker.ts"` so the custom Worker entrypoint can handle
Astro SSR requests and the daily scheduled trigger.

## Scheduled Maintenance

Wrangler config includes a daily cron trigger (`0 7 * * *`). It runs two jobs independently, so a
failure in one does not hide a failure in the other:

- `cleanupVerificationState`, which keeps 30 days of consumed/expired property-verification rows
  and resolved manual-approval rows (pending manual approvals are retained), plus the ADR 0022
  phase 3c equivalents: pending Person Verification codes (`verification_codes`) age out after
  about a day past consumption/expiry, since a code is only ever useful for its ~10-minute TTL, and
  resolved (accepted/declined) verification review requests (`verification_review_requests`) age
  out after 30 days — open requests are retained.
- The ADR 0022 invariant drift check (`runInvariants`, the same 17 checks `npm run
verify:invariants` runs) — added by #240 so the phase-4 soak isn't running without automated
  drift detection. A violation is logged (IDs and codes only, never a personal value) and fails the
  cron invocation, which surfaces as a red run in Workers Logs/the Cloudflare dashboard; nothing is
  stored, and a real violation re-fires every day until it's fixed.

Neither job's failure blocks the other; if either fails, the invocation throws so the dashboard
shows the run as failed.

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
settings, roster records, homeowner access, board membership, the board roster, meetings,
resolutions, recorded elections, proxies, and saved AI reports. Changes are written to D1/R2 and
appear on the site without a code deploy.

## Official Mode

The public site defaults to unofficial resident mode. In this mode it presents as an independent,
resident-run information hub, shows the disclaimer, and hides official-HOA surfaces such as dues
navigation.

If the HOA board formally adopts the site, a board member can enable official mode from `/admin` ->
**Site Settings**. The change is stored in D1 and takes effect on the next SSR page request.

## Live Voting Rollout

Live Voting is a separate, default-off operational gate. Homeowner `/vote` and `/api/vote`
surfaces are available only while both **Official Mode** and **Live Voting** are enabled in
`/admin` -> **Site Settings**. Do not enable Live Voting in production until the board has formally
adopted the site for official business and recorded its authorization of the live-voting process.

Turning Live Voting off is the emergency pause. It blocks new opens and casts but does not close an
open election or motion, replace its frozen electorate, or delete received ballots, motion votes,
or lifecycle history. Turning it back on resumes every item that was already open, so review all
active elections and motions before re-enabling it.

After every production deploy, confirm in **Site Settings** that **Live Voting** remains off
(`liveVotingEnabled: false`). The safe code default is false, but the D1 setting persists across
deploys and is not reset by a new build. Before the first production enablement:

- [ ] Confirm the board's formal adoption and live-voting authorization are recorded.
- [ ] Confirm the deployed revision passed CI and Live Voting is still off after deployment.
- [ ] In a non-production environment, smoke-test an eligible homeowner and held-proxy cast for a
      conducted election and a member motion, including selection-free receipts.
- [ ] Verify a second or stale cast is rejected, open elections expose turnout but no live tally,
      and closing derives the expected weighted result.
- [ ] Pause an open test item by turning Live Voting off, confirm voting surfaces are hidden, then
      turn it back on and confirm the lifecycle, frozen eligibility, and received casts resume
      unchanged.
- [ ] Review every production item that would resume, then have the designated board operator
      enable both required settings and verify `/vote` with a controlled eligible account.

This rollout uses the existing D1 site setting and standard deployment steps; it adds no Cloudflare
resource, binding, or secret.

## Public Architecture

See [AGENTS.md](./AGENTS.md) for the architecture overview, [docs/agents/](./docs/agents/) for
per-surface detail, and [docs/adr/](./docs/adr/) for durable architecture decisions.
