# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The public website for the Valleys at Ashebrook HOA. A static Astro site with React
islands, backed entirely by Firebase free-tier services (Firestore, Storage, Auth,
Hosting) plus a public Google Calendar and Web3Forms for the contact form. Board
members manage all content through a password-protected admin panel at `/admin` — no
code changes needed to edit content. `SETUP.md` is the human deployment guide.

## Commands

```bash
npm run dev          # dev server at http://localhost:4321
npm run build        # static build to dist/
npm run check        # Astro + TypeScript type check
npm test             # run Vitest suite once
npm run test:watch   # Vitest in watch mode
npm run format       # Prettier write; format:check is what CI enforces
npm run emulators    # Firebase Emulator Suite (auth/firestore/storage)
npm run deploy       # astro build && firebase deploy
```

Run a single test file or name:

```bash
npx vitest run src/components/react/AnnouncementsList.test.tsx
npx vitest run -t "shows an empty message"
```

Node version is pinned in `.nvmrc` (run `nvm use`). CI (`.github/workflows/build.yml`)
runs `format:check`, `check`, `test`, then `build` on every push and PR — run these
locally before pushing.

## Architecture

**Rendering model.** Pages are `.astro` files in `src/pages/` wrapped in
`BaseLayout.astro`. All dynamic content is a React island mounted with
`client:only="react"` (the data is fetched client-side from Firestore, so there is no
SSR of live content). Static, build-time content (e.g. the Google Calendar embed in
`calendar.astro`) is computed in the Astro frontmatter from `import.meta.env`.

**Firebase access is lazy and centralized.** `src/lib/firebase.ts` holds singleton
getters (`getDb`, `getFirebaseAuth`, `getStorageInstance`) that initialize the app on
first use and throw if config is absent. Never call `getFirestore`/`getAuth` directly
elsewhere — go through these getters. Setting `PUBLIC_USE_EMULATORS=true` makes them
connect to the local emulators (browser only).

**Read/write split.**

- `src/lib/content.ts` — public read helpers (announcements, documents, dues, site
  settings). Used by the public React islands.
- `src/lib/admin.ts` — write helpers (create/update/delete, file upload). Used only by
  the admin app.
- `src/lib/types.ts` — shared Firestore data shapes plus `DEFAULT_*` fallbacks and
  `DOCUMENT_CATEGORIES`. Reads merge stored data over the defaults, so missing fields
  are safe.

**Data model (Firestore).** Collections: `announcements`, `documents` (metadata only;
PDFs live in Cloud Storage under `documents/`), `settings` (singleton docs `dues` and
`site`), and `admins` (one doc per board member, keyed by Auth UID). A user is an admin
iff a doc with their UID exists in `/admins`.

**Security is enforced by rules, not client code.** `firestore.rules` and
`storage.rules` are the source of truth: public read, admin-only write, and `/admins`
is console-managed (`allow write: if false`). The client `checkIsAdmin` is only for UI

- Component specs live next to the component (`*.test.tsx`).
- Page-level integration tests use the Astro Container API
  (`src/test/pages.test.ts`) and **must** declare `// @vitest-environment node` at the
  top — the container's esbuild compile conflicts with jsdom's `TextEncoder`.
