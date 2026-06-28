# HOA Community Website

A simple, friendly website for a homeowners association, built with
[Next.js](https://nextjs.org) (App Router), TypeScript, and Tailwind CSS.

It gives your community one place for:

- 📣 **Announcements** — news and notices from the board (written in Markdown)
- 📅 **Community calendar** — meetings and neighborhood events
- 📄 **Governing documents** — CC&Rs, bylaws, forms, financials (PDF downloads)
- ✉️ **Contact form** — residents reach the board by email
- 💳 **Online dues payment** — secure checkout via Stripe

The whole site is **content-file driven** so a non-developer can keep it up to
date by editing a few files — no database to run, cheap and easy to host.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

That's it — the site works out of the box with sample content. Email and
payments degrade gracefully until you configure them (see below).

### Other commands

```bash
npm run build        # production build
npm run start        # run the production build
npm run lint         # ESLint
```

---

## Customizing for your community

Almost everything you'll want to change lives in a handful of files. No coding
experience is required for day-to-day updates.

### 1. Association details — `src/lib/site.ts`

Set your HOA's name, address, contact email/phone, meeting info, and the
**dues options** shown on the payment page. Edit the text between the quotes.

### 2. Announcements — `content/announcements/*.md`

Each announcement is one Markdown file. To post a new one, copy an existing
file and edit the top section (the "frontmatter") plus the body:

```markdown
---
title: Pool Opens Memorial Day Weekend
date: 2026-05-20
author: Recreation Committee
pinned: false
summary: One-sentence preview shown in the list.
---

Your announcement text here. **Bold**, lists, and links all work.
```

The file name (without `.md`) becomes the page's web address.

### 3. Calendar events — `content/events.json`

Add an object to the list for each event:

```json
{
  "title": "Monthly Board Meeting",
  "date": "2026-07-14",
  "time": "7:00 PM",
  "location": "Clubhouse",
  "description": "Open to all residents."
}
```

`time`, `location`, and `description` are optional. Past events automatically
move into a collapsible "Past Events" section.

### 4. Documents — `content/documents.json` + `public/documents/`

1. Put the PDF in `public/documents/` (e.g. `public/documents/bylaws.pdf`).
2. Add an entry to `content/documents.json`:

```json
{
  "title": "Bylaws",
  "category": "Governing Documents",
  "file": "bylaws.pdf",
  "updated": "2025-01-15",
  "description": "How the association operates and elects its board."
}
```

> The sample PDFs included here are placeholders — replace them with your real
> documents.

---

## Email & payments (optional setup)

Copy `.env.example` to `.env.local` and fill in only what you need.

### Contact form email (Resend)

1. Create a free account at [resend.com](https://resend.com) and get an API key.
2. Set `RESEND_API_KEY` (and optionally `CONTACT_TO_EMAIL` / `CONTACT_FROM_EMAIL`).

Until this is set, submitted messages are logged to the server console and the
form still reports success — handy for local testing.

### Dues payments (Stripe)

1. Create an account at [stripe.com](https://stripe.com) and get a secret key.
2. Set `STRIPE_SECRET_KEY` (use a `sk_test_...` key while testing).
3. Set `NEXT_PUBLIC_SITE_URL` to your site's URL so receipts redirect correctly.

The charged amount always comes from the server-side `duesOptions` list in
`src/lib/site.ts` — never from the browser — so amounts can't be tampered with.
Until a key is set, the dues page shows a "coming soon" notice with the board's
contact info.

---

## Deploying

This is a standard Next.js app and deploys anywhere that runs Node.js. The
simplest option is [Vercel](https://vercel.com):

1. Push this folder to its own Git repository (see below).
2. Import the repo in Vercel.
3. Add your environment variables (`RESEND_API_KEY`, `STRIPE_SECRET_KEY`,
   `NEXT_PUBLIC_SITE_URL`, …) in the Vercel project settings.

---

## Pushing to GitHub

This project is set up as its own standalone repository, with `origin` already
pointed at <https://github.com/jwh3times/valleys-at-ashebrook-hoa>. After
unpacking it:

```bash
npm install            # restore dependencies (node_modules is not included)
git push -u origin main
```

If you ever need to re-point or re-initialize the remote:

```bash
git remote set-url origin https://github.com/jwh3times/valleys-at-ashebrook-hoa.git
```

(`node_modules/` and `.env.local` are excluded by `.gitignore`.)

---

## Project structure

```text
content/                  Editable site content (no code)
  announcements/*.md      One Markdown file per announcement
  events.json             Community calendar events
  documents.json          Governing-document listing
public/documents/         The actual PDF files
src/
  app/                    Pages and API routes (Next.js App Router)
    api/contact/          Contact-form handler (Resend or console log)
    api/checkout/         Stripe Checkout session creator
  components/             Navbar, Footer, forms, page header
  lib/                    Content loaders + site config (site.ts)
```

---

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** for styling
- **gray-matter** + **marked** for Markdown announcements
- **Stripe** for dues checkout
- **Resend** (via REST) for contact-form email
- **zod** for server-side input validation
