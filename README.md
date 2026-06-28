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

## Tech stack

| Concern | Choice | Cost |
| --- | --- | --- |
| Framework | [Astro](https://astro.build) + React | Free |
| Database | Firebase Firestore | Free (Spark) |
| File storage | Firebase Storage | Free (Spark) |
| Auth | Firebase Authentication (email/password) | Free (Spark) |
| Hosting | Firebase Hosting | Free (Spark) |
| Calendar / Meet | Public Google Calendar | Free |
| Contact email | [Web3Forms](https://web3forms.com) → Gmail | Free |

The whole site runs on free tiers with **no recurring cost** (a custom domain is
the only optional expense, ~$10–15/yr). Firebase's free plan does not pause.

## Getting started

See **[SETUP.md](./SETUP.md)** for the complete, step-by-step setup and
deployment guide.

Quick commands:

```bash
npm install      # install dependencies
npm run dev      # local dev server at http://localhost:4321
npm run build    # build the static site to dist/
npm run deploy   # build + deploy to Firebase Hosting
```

## Project layout

```
src/
  pages/              Astro pages (home, announcements, calendar, documents, dues, contact, admin)
  layouts/            Shared page shell
  components/         Header/Footer + React islands
    react/            Public dynamic content (announcements, documents, dues, contact form)
    admin/            The board admin app (login + managers)
  lib/                Firebase init, Firestore read/write helpers, types
  styles/             Global CSS
firestore.rules       Database security rules (public read, admin write)
storage.rules         File storage security rules
firebase.json         Firebase Hosting/Firestore/Storage config
```

## How content is edited

Board members go to `/admin`, sign in with their email + password, and manage
announcements, documents, dues, and site text through on-screen forms. Access is
controlled by the Firestore `admins` collection — see SETUP.md.
