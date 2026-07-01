# Resident Rebrand + Official-Mode Flag — Design Spec

**Date:** 2026-07-01
**Status:** Draft for review

---

## 1. Context

The site is live at `ashebrookresidents.com`, deployed as an Astro SSR app on
Cloudflare Workers (D1 + R2 + KV, Better Auth). It was designed and built as the
**official** website for the "Valleys at Ashebrook HOA": it calls itself the
"official website for the Valleys at Ashebrook Homeowners Association," routes a
"Contact the Board" form to the maintainer's inbox, fronts a "Pay Your Dues" flow,
and brands the header "Valleys at Ashebrook / Homeowners Association."

The maintainer is a resident of the neighborhood, **not** a board member and not a
representative of the HOA. They personally own every account the site uses (Cloudflare,
domain, email/SMS providers) and built this on their own initiative — the HOA neither
requested it, owns it, nor endorses it. Presenting it as the official HOA site is
therefore inaccurate and carries representation risk.

The maintainer wants to **preserve** the official-HOA implementation (they may pitch
the site to the board for adoption later), but by default present the site truthfully:
an independent, resident-run information hub for neighbors, clearly disclaimed as
unaffiliated, with the "official" surfaces hidden behind a toggle they can flip live if
the board ever adopts it.

Platform is unchanged: Astro `output: 'server'` on `@astrojs/cloudflare`, D1 (Drizzle),
R2, KV, Better Auth. `env` via `import { env } from 'cloudflare:workers'`; authorization
stays server-side.

---

## 2. Goals and non-goals

### Goals
1. Rebrand the public site to **"The Valleys at Ashebrook Residents"** and remove
   "HOA" / "Homeowners Association" / "official" framing from default (unofficial) copy.
2. Add an **official-mode** feature flag stored in D1 site settings, **toggleable live
   from the admin dashboard** (no redeploy). Default **off**.
3. When official mode is **off**, gate the official-HOA surfaces (dues UI, "the Board"
   framing, "official" language, "Homeowners Association" tag) and show a clear
   "not affiliated with the HOA, built and maintained by a resident" disclaimer in the
   footer on every page plus a dedicated `/about` page. When **on**, restore today's
   behavior and drop the disclaimer.
4. Preserve all existing official-HOA functionality behind the flag — nothing is
   deleted; it is conditionally rendered.
5. Centralize brand strings and mode/disclaimer copy so future changes and the
   eventual flip are maintainable.

### Non-goals
- Renaming live Cloudflare resources (D1 `ashebrook-hoa`, R2 `ashebrook-hoa-docs`) —
  out of scope; not user-facing and would require migration/redeploy risk. See §11.
- Renaming the GitHub repository — a GitHub-side action the maintainer does separately.
- Expanding the admin beyond the official-mode toggle + chrome relabel (explicitly
  scoped out this round; see §8).
- Managing the disclaimer / About copy from the admin UI (copy lives in code for now).
- Changing auth, roles, visibility tiers, or the content data model.

---

## 3. The official-mode flag

### 3.1 Data model
`officialMode: boolean` is added to `SiteSettings` (`src/lib/types.ts`), default
`false` in `DEFAULT_SITE_SETTINGS`. It persists inside the existing single JSON blob in
the D1 `settings` row keyed `site` — **no schema/migration change, no new endpoint**.
It is written by the existing whole-blob `PUT /api/admin/site` and returned by
`GET /api/content/site`.

### 3.2 Server-side read path (the key new piece)
Today no `.astro` page reads site settings server-side — nav, hero, and titles are
hardcoded, and React islands fetch content client-side. For the flag to drive
server-rendered `Header`, `Footer`, and page copy **without a client-side flash**, the
value must be available in `.astro` frontmatter at render time.

- Add a server helper **`getSiteSettings(env): Promise<SiteSettings>`** (new
  `src/server/content/settings.ts`) that reads the `site` row, `JSON.parse`s it,
  merges over `DEFAULT_SITE_SETTINGS`, and applies the `hoaName` → `siteName`
  back-compat fallback (§5). Fail-closed: any error → defaults (official mode off).
- **Extend the existing `src/middleware.ts` `onRequest`** (it already computes
  `getAuthContext` and sets `context.locals.authContext`). For HTML page requests it
  additionally calls `getSiteSettings(env)` once and assigns it to
  `context.locals.site`; it short-circuits for `/api/*` so API/file routes take no extra
  D1 read. `App.Locals` in `src/env.d.ts` (which already declares `authContext`) gains
  `site: SiteSettings`.
- **`GET /api/content/site` is refactored to delegate to `getSiteSettings`**, so the
  SSR path and the client path (`fetchSiteSettings` → `SiteManager`) share one
  normalization path.
- `.astro` pages, `BaseLayout`, `Header`, and `Footer` read `Astro.locals.site`
  (`officialMode`, `siteName`) — one indexed D1 read per page request.

### 3.3 Live toggle semantics
Flipping the toggle writes the blob to D1; the **next page request** reads the new
value and renders the other mode. Astro SSR responses are dynamic (not edge-cached by
default), so the change is effectively immediate. Mode-gated markup is server-rendered
in `.astro`, so it flips cleanly with no client-side flash. (Client React islands —
announcements, documents, dues form — are unaffected by the flag except where the
parent `.astro` chooses whether to render them.)

---

## 4. Branding module (`src/lib/site.ts`)

New module centralizing brand constants and copy so literals aren't scattered:

- `SITE_NAME = 'The Valleys at Ashebrook Residents'`
- `NEIGHBORHOOD = 'The Valleys at Ashebrook'`
- `OFFICIAL_ORG_NAME = 'Valleys at Ashebrook HOA'` (used only in official-mode copy and
  in the disclaimer's "not affiliated with …" line)
- `DISCLAIMER_SHORT` — the one-line footer disclaimer (§7)
- `DISCLAIMER_LONG` — the `/about` full statement (§7)

Brand strings that are per-mode (e.g., the header tag "Residents" vs. "Homeowners
Association", the site title suffix) are selected in the component from
`locals.site.officialMode`; this module holds the raw strings.

---

## 5. `hoaName` → `siteName` rename

- Rename the `SiteSettings.hoaName` field to `siteName` in `src/lib/types.ts`;
  `DEFAULT_SITE_SETTINGS.siteName = 'The Valleys at Ashebrook Residents'`.
- Update all readers/writers: `SiteManager.tsx`, any consumer of the field.
- **Back-compat, no migration:** the stored blob may still contain `hoaName`.
  Normalization is centralized in `getSiteSettings`: if `siteName` is absent but
  `hoaName` is present, map it over and drop `hoaName`. Because `GET /api/content/site`
  delegates to `getSiteSettings` (§3.2), client reads (`SiteManager`) receive `siteName`
  too. The next admin save rewrites the blob with `siteName`. No production data is
  touched.

---

## 6. Mode-gated public surfaces

| Surface / file | Official mode ON | OFF (default) |
|---|---|---|
| Header nav "Dues" link (`Header.astro`) | shown | hidden |
| Header brand tag (`Header.astro`) | "Homeowners Association" | "Residents" |
| Public "Board Login" link (`Header.astro`) | relabeled "Admin sign in" **always** | "Admin sign in" |
| Home meta description + hero + tiles (`index.astro`) | "official website… / Pay Dues / Contact the Board" | resident-focused copy, no "official", no Pay-Dues CTA, "Contact" tile |
| `/dues` (`dues.astro`) | full `DuesInfo` island | static message: dues are handled by the HOA; contact the HOA board with questions |
| Contact (`contact.astro`, `ContactForm.tsx`) | "Contact the Board" → "the board's inbox" | "Contact" → reaches "the resident who maintains this site"; mailing block drops "HOA" |
| Footer disclaimer (`Footer.astro`) | hidden | shown (short line + link to `/about`) |
| Title suffix (`BaseLayout.astro`) | "… \| Valleys at Ashebrook HOA" | "… \| The Valleys at Ashebrook Residents" |

Always-on rename (not mode-gated): page `<title>`/meta text, footer copyright name,
auth email subjects/bodies ("Reset your HOA password" → "Reset your The Valleys at
Ashebrook Residents password", "Verify your … account", "Your … verification code" in
`src/server/auth/index.ts` and `src/server/verification/property.ts`), the
`welcomeBody` default copy, `ContactForm` `from_name`/`subject`, and admin chrome
("Board Admin" → "Site Admin", sidebar text).

---

## 7. Disclaimer + `/about` page

### Footer (every page, official mode off) — `DISCLAIMER_SHORT`
> Not affiliated with, endorsed by, or operated by the Valleys at Ashebrook HOA or its
> board. An independent site built and maintained by a resident of the neighborhood.
> [About this site](/about)

### New `/about` page (`src/pages/about.astro`) — `DISCLAIMER_LONG`
Full statement, shown regardless of mode — the About page always tells the truth about
ownership. Covers:
- What this site is: an independent, resident-built information hub for neighbors in
  The Valleys at Ashebrook.
- Explicit disclaimer: not affiliated with, endorsed by, or operated by the HOA or its
  board; the HOA does not own or control it.
- It runs on a resident's personal accounts and a personally-owned domain, built and
  maintained by that resident on their own initiative.
- For official HOA business (dues, governing decisions, disputes), contact the HOA or
  its management company directly.
- How to reach the site maintainer (via the Contact page).

An "About" link is added to the footer, next to the disclaimer (not the main nav, to
keep the nav clean). The two constants above are the source of truth for the copy;
exact prose is finalized in implementation.

---

## 8. Admin toggle (scope: toggle + relabel only)

- Add an **Official mode** on/off control at the top of the existing **Site Settings**
  section (`SiteManager.tsx`), with a one-line explanation of what it changes ("When
  off, the site presents as an unofficial resident-run hub with a disclaimer and hides
  dues/board features"). It reads/writes `officialMode` through the existing
  `fetchSiteSettings` / `saveSite` blob flow — no new endpoint.
- Relabel admin chrome away from "Board": `admin/index.astro` title "Board Admin" →
  "Site Admin"; `AdminApp.tsx` sidebar/`sr-only` heading; description text.
- Out of scope this round: overview/landing screen, admin-managed disclaimer/About copy.

---

## 9. Files touched (checklist)

**New**
- `src/lib/site.ts` — brand constants + disclaimer copy
- `src/server/content/settings.ts` — `getSiteSettings(env)` + `hoaName`→`siteName` normalize
- `src/pages/about.astro` — About / disclaimer page

**Edited**
- `src/middleware.ts` — also populate `context.locals.site` for page requests (already sets `authContext`)
- `src/pages/api/content/site.ts` — delegate `GET` to `getSiteSettings`
- `src/lib/types.ts` — `hoaName`→`siteName`, add `officialMode`, defaults
- `src/env.d.ts` — extend `App.Locals` (already declares `authContext`) with `site: SiteSettings`
- `src/layouts/BaseLayout.astro` — title suffix from `siteName`; read `locals.site`
- `src/components/Header.astro` — mode-gated nav/tag, relabel login, read `locals.site`
- `src/components/Footer.astro` — name + mode-gated disclaimer line
- `src/pages/index.astro` — mode-gated hero/tiles/meta
- `src/pages/dues.astro` — mode-gated dues vs. static message
- `src/pages/contact.astro` + `src/components/react/ContactForm.tsx` — reframe wording
- `src/pages/{announcements,documents,login,register,calendar}.astro` — meta/title copy
- `src/pages/admin/index.astro`, `src/components/admin/AdminApp.tsx`,
  `src/components/admin/SiteManager.tsx` — relabel + toggle
- `src/server/auth/index.ts`, `src/server/verification/property.ts` — email copy
- `src/lib/content.ts` — `hoaName`→`siteName` type rename (normalization is centralized server-side via the site API)
- `.env.example`, `SETUP.md`, `README.md` — docs referencing HOA/branding as needed

**Not touched:** `wrangler.toml` binding/resource names, `scripts/import-*.ts`
resource names, test fixture IDs (`doc-hoa`, etc.), `design/Ashebrook HOA.dc.html`.

---

## 10. Testing

- Update existing unit/component tests that assert changed copy (e.g.,
  `DuesInfo.test.tsx` if affected, `AdminApp.test.tsx`, any title/footer assertions).
- New tests:
  - `getSiteSettings` normalizes legacy `hoaName` → `siteName` and defaults
    `officialMode` to `false` on missing/corrupt rows (server or unit).
  - `SiteManager` renders and toggles the official-mode control and includes it in the
    saved payload.
  - Mode-gated rendering: with `officialMode` off, `Header` hides the Dues link and
    `Footer` shows the disclaimer; with it on, the reverse. (Component-level where
    feasible; middleware/`locals` wiring covered by a server test if practical.)
- CI gates unchanged: `format:check`, `check`, `test`, `build` must pass.

---

## 11. Out of scope / follow-ups
- **GitHub repo rename** (`valleys-at-ashebrook-hoa` → e.g. `ashebrook-residents`) —
  maintainer action on GitHub; update local remote afterward.
- **Cloudflare resource rename** (D1/R2) — deliberately deferred; carries migration
  risk and is not user-facing.
- Admin-managed disclaimer/About copy and a broader admin overview — future round.
- Revisiting the flag storage (e.g., dedicated settings key) if site settings grow.
