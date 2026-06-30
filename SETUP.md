# Setup Guide — Valleys at Ashebrook HOA Website

This site is built with [Astro](https://astro.build) (public pages) + [React](https://react.dev)
(the admin panel), and uses **Firebase** for the database, file storage,
authentication, and hosting. Everything fits in Firebase's **free Spark plan**,
which does not expire or pause.

Total cost: **$0** (optional ~$10–15/yr only if you want a custom domain).

Follow the steps in order. You only do this once.

---

## What you'll need

- A Google account (the HOA Gmail is perfect).
- About 30–45 minutes.
- [Node.js 18+](https://nodejs.org) installed on your computer (only needed to
  build/deploy from your machine; not needed for day-to-day editing).

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and sign in with the HOA Google
   account.
2. Click **Add project**, name it (e.g. `valleys-ashebrook-hoa`), and finish.
   You can disable Google Analytics — it isn't needed.

## 2. Enable the services

In the Firebase console for your new project:

- **Authentication** → *Get started* → enable **Email/Password**.
- **Firestore Database** → *Create database* → start in **production mode** →
  pick a location close to you.
- **Storage** → *Get started* → accept the default rules prompt (we'll deploy
  our own rules later).

## 3. Get your web config

1. In the console, click the gear icon → **Project settings**.
2. Under **Your apps**, click the **Web** icon (`</>`) to register a web app
   (give it any nickname; you do **not** need Firebase Hosting checkbox here).
3. Copy the `firebaseConfig` values shown.

Create a file named `.env` in the project root (copy from `.env.example`) and
fill in the values:

```
PUBLIC_FIREBASE_API_KEY=...
PUBLIC_FIREBASE_AUTH_DOMAIN=...
PUBLIC_FIREBASE_PROJECT_ID=...
PUBLIC_FIREBASE_STORAGE_BUCKET=...
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
PUBLIC_FIREBASE_APP_ID=...
```

> These values are safe to commit/ship — they're public by design. Security is
> enforced by the rules files, not by hiding the config. (The `.env` file is
> gitignored only to keep per-environment values out of the repo.)

## 4. Install tools and deploy the security rules

```bash
npm install
npm install -g firebase-tools     # one time
firebase login                    # sign in with the HOA Google account
```

Edit `.firebaserc` and replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID` with your
actual project ID, then deploy the rules:

```bash
firebase deploy --only firestore:rules,storage
```

## 5. Create board member accounts

Board members log in with **email + password** — no GitHub or Google account
required.

1. Firebase console → **Authentication** → **Users** → **Add user**. Enter each
   board member's email and a temporary password. (They can change it later via
   the "Forgot password" link on the login page.)
2. For each user, copy their **User UID** (shown in the Users table).

## 6. Grant admin rights

The site treats a user as a board admin only if a document with their UID exists
in the `admins` collection.

1. Firebase console → **Firestore Database** → **Start collection** → collection
   ID `admins`.
2. For each board member, add a document whose **Document ID is their User UID**
   (from step 5). It can have a single field for reference, e.g.
   `email: "name@example.com"`.

Repeat for every board member who should be able to edit the site.

## 7. Connect the community calendar

1. Open [Google Calendar](https://calendar.google.com) with the HOA account
   (or create a dedicated "Valleys at Ashebrook HOA" calendar).
2. Calendar **Settings** → select the calendar → **Access permissions** → check
   **Make available to public** (set to "See all event details").
3. Scroll to **Integrate calendar** and copy the **Calendar ID**
   (looks like `xxxx@group.calendar.google.com`).
4. Put it in `.env`:
   ```
   PUBLIC_GOOGLE_CALENDAR_ID=xxxx@group.calendar.google.com
   PUBLIC_GOOGLE_CALENDAR_TIMEZONE=America/New_York
   ```

**Virtual meetings (Google Meet):** when you create an event in this calendar,
click **Add Google Meet video conferencing**. The Meet link is saved in the
event, so homeowners just open the event on the website's calendar and click to
join — no extra setup.

## 8. Connect the contact form

1. Go to <https://web3forms.com>, enter the HOA Gmail address, and get a free
   **Access Key** (it's emailed to you). Submissions are delivered to that
   inbox.
2. Put it in `.env`:
   ```
   PUBLIC_WEB3FORMS_KEY=your-access-key
   ```

## 9. Deploy the website

```bash
npm run build      # builds the static site into dist/
firebase deploy --only hosting
```

Firebase prints your live URL (e.g. `https://valleys-ashebrook.web.app`).
Update the `site` value in `astro.config.mjs` to match.

> Tip: `npm run deploy` runs the build and a full `firebase deploy` together.

## 10. Add your first content

Go to `https://your-site.web.app/admin`, sign in as a board member, and use the
tabs to:

- **Announcements** — post community news (optionally pin important ones).
- **Documents** — upload governing-document PDFs (bylaws, CC&Rs, minutes).
- **Dues** — set the dues amount and add payment options (PayPal/Venmo/Zelle/check).
- **Site Settings** — edit the home-page welcome text and public contact email.

---

## Optional: custom domain

In the Firebase console → **Hosting** → **Add custom domain**, follow the DNS
steps. Buy a domain from any registrar (~$10–15/yr). Firebase provides the SSL
certificate for free. Then update `site` in `astro.config.mjs`.

---

## Local development

```bash
npm run dev        # http://localhost:4321
```

To test against local fakes instead of the live Firebase project, install the
emulators and set `PUBLIC_USE_EMULATORS=true` in `.env`:

```bash
firebase init emulators   # one time (auth, firestore, storage)
npm run emulators         # in one terminal
npm run dev               # in another
```

---

## Day-to-day: how board members update the site

They don't need any of the above. They just:

1. Go to `https://your-site.web.app/admin`
2. Sign in with their email + password
3. Edit through the on-screen forms — changes appear on the site immediately.

## Where things live (quick reference)

| Thing | Where |
| --- | --- |
| Announcements, dues, site text | Firestore (`announcements`, `settings`) |
| Document PDFs | Cloud Storage (`documents/`) + metadata in Firestore |
| Calendar & Meet links | The HOA's public Google Calendar |
| Contact form emails | Web3Forms → HOA Gmail |
| Who can edit | Firestore `admins` collection (by user UID) |
| Hosting | Firebase Hosting |

---

## Cloudflare provisioning (run once, needs account)

The `wrangler.toml` file uses placeholder IDs (`"local-dev-placeholder"`) for the D1
database and KV namespace. Before deploying to Cloudflare Workers/Pages, a Cloudflare
account holder must run the following commands **once** and replace the placeholder
values with the real IDs output by each command.

```bash
# Log in to Cloudflare
wrangler login

# Create the D1 database — copy the "database_id" from the output
wrangler d1 create ashebrook-hoa

# Create the KV namespace — copy the "id" from the output
wrangler kv namespace create KV
```

After running the above, open `wrangler.toml` and replace:

- `database_id = "local-dev-placeholder"` with the real D1 database ID
- `id = "local-dev-placeholder"` (under `[[kv_namespaces]]`) with the real KV namespace ID

Then apply the D1 migrations for the first time:

```bash
# Apply locally (uses Wrangler's local SQLite emulation)
npm run db:migrate:local

# Apply against the live Cloudflare D1 database
npm run db:migrate:remote
```

Copy `.dev.vars.example` to `.dev.vars` and fill in the secrets (never commit `.dev.vars`):

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set BETTER_AUTH_SECRET to a strong random value:
#   openssl rand -base64 32
```

---

## Create the first board account (one-time bootstrap)

After deploying the Worker and after applying the roster import, you must seed the first
board member account. Because no admin exists yet, the normal self-service flow cannot be
used — instead, `seedBoard` writes the `role` and `emailVerified` fields directly in the
database.

**When to run:** once, immediately after the first `wrangler deploy` and roster import.

**How to run:** add a short-lived admin route to the Worker (or call it inline from a
temporary script under `wrangler dev`) that reads `BOARD_EMAIL`, `BOARD_PASSWORD`, and
`BOARD_NAME` from environment variables and calls `seedBoard`:

```ts
import { seedBoard } from '../../scripts/seed-board';

// Example: temporary Hono route — remove after first use.
app.get('/internal/bootstrap', async (c) => {
  const userId = await seedBoard(
    c.env,
    c.env.BOARD_EMAIL,
    c.env.BOARD_PASSWORD,
    c.env.BOARD_NAME,
  );
  return c.text(`board account created: ${userId}`);
});
```

Set the variables in `.dev.vars` (local) or as Cloudflare secrets (remote), hit the
route once, then **remove it before the next deploy**.

The `seedBoard` function:

1. Creates the user via `auth.api.signUpEmail` (which also sends a verification email if
   `EMAIL_API_KEY` is configured — ensure the email secrets are set before running).
2. Immediately sets `role = 'board'` and `emailVerified = true` directly in the database,
   so the account is usable even if the verification email is not acted upon.

After seeding, the board member can log in at `/login` and change their password via the
**Forgot password** link. Remove the temporary bootstrap route from your Worker before
the next deploy.
