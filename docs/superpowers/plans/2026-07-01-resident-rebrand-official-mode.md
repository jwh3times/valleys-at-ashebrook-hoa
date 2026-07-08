# Resident Rebrand + Official-Mode Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the public site to "The Valleys at Ashebrook Residents" and add a live, admin-toggleable **official-mode** feature flag that hides the official-HOA surfaces behind a disclaimer by default.

**Architecture:** The flag (`officialMode: boolean`, default `false`) lives inside the existing D1 `site` settings JSON blob. A new `getSiteSettings(env)` server helper reads + normalizes it; the existing `src/middleware.ts` surfaces it on `Astro.locals.site` for every page request; `.astro` chrome/pages and a small pure `src/lib/site.ts` module drive mode-dependent nav, copy, and the disclaimer. Nothing is deleted — official-HOA surfaces are conditionally rendered.

**Tech Stack:** Astro `output: 'server'` on `@astrojs/cloudflare` (SSR on Cloudflare Workers), D1 via Drizzle, Better Auth, React islands, Vitest (jsdom + `@cloudflare/vitest-pool-workers`).

## Global Constraints

- Public site name (unofficial mode): **`The Valleys at Ashebrook Residents`** (verbatim).
- Neighborhood name: **`The Valleys at Ashebrook`** (verbatim).
- Official org name — used **only** in official-mode copy and in the disclaimer's "not affiliated with …" line: **`Valleys at Ashebrook HOA`** (verbatim).
- Feature flag default: `officialMode = false`.
- No DB migration and no new API endpoint — the flag rides the existing whole-blob `PUT /api/admin/site` / `GET /api/content/site`.
- Do **not** rename: Cloudflare resources (D1 `ashebrook-hoa`, R2 `ashebrook-hoa-docs`), test fixture IDs (`doc-hoa`, etc.), or the GitHub repo.
- Authorization stays server-side; runtime `env` via `import { env } from 'cloudflare:workers'`.
- CI gates must pass before done: `npm run format:check`, `npm run check`, `npm test`, `npm run build`.
- Every commit message ends with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Branding module + settings type/normalizer

**Files:**

- Modify: `src/lib/types.ts` (rename `hoaName`→`siteName`, add `officialMode`, add `normalizeSiteSettings`)
- Create: `src/lib/site.ts` (brand constants + pure presentation helpers)
- Test: `test/unit/site.test.ts`

**Interfaces:**

- Produces: `SiteSettings` (now `{ siteName, tagline, contactEmail, welcomeHeading, welcomeBody, officialMode }`); `DEFAULT_SITE_SETTINGS`; `normalizeSiteSettings(raw: unknown): SiteSettings`.
- Produces (`src/lib/site.ts`): `SITE_NAME`, `NEIGHBORHOOD`, `OFFICIAL_ORG_NAME`, `DISCLAIMER_SHORT: string`, `DISCLAIMER_LONG: string[]`, `navLinks(officialMode: boolean): {href,label}[]`, `brandTag(officialMode: boolean): string`, `displayName(s: Pick<SiteSettings,'officialMode'|'siteName'>): string`, `siteTitle(pageTitle: string, s: Pick<SiteSettings,'officialMode'|'siteName'>): string`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/site.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  navLinks,
  brandTag,
  displayName,
  siteTitle,
  SITE_NAME,
  OFFICIAL_ORG_NAME,
} from '../../src/lib/site';
import {
  normalizeSiteSettings,
  DEFAULT_SITE_SETTINGS,
} from '../../src/lib/types';

describe('site branding helpers', () => {
  it('hides the Dues nav link when official mode is off, shows it when on', () => {
    expect(navLinks(false).some((l) => l.href === '/dues')).toBe(false);
    expect(navLinks(true).some((l) => l.href === '/dues')).toBe(true);
  });

  it('brandTag reflects the mode', () => {
    expect(brandTag(false)).toBe('Residents');
    expect(brandTag(true)).toBe('Homeowners Association');
  });

  it('displayName uses the resident name when off and the org name when on', () => {
    const base = { ...DEFAULT_SITE_SETTINGS };
    expect(displayName({ ...base, officialMode: false })).toBe(SITE_NAME);
    expect(displayName({ ...base, officialMode: true })).toBe(
      OFFICIAL_ORG_NAME,
    );
  });

  it('siteTitle drops the suffix for Home and adds it otherwise', () => {
    const s = { ...DEFAULT_SITE_SETTINGS, officialMode: false };
    expect(siteTitle('Home', s)).toBe(SITE_NAME);
    expect(siteTitle('Dues', s)).toBe(`Dues | ${SITE_NAME}`);
  });
});

describe('normalizeSiteSettings', () => {
  it('defaults officialMode to false and siteName to the resident name', () => {
    const s = normalizeSiteSettings({});
    expect(s.officialMode).toBe(false);
    expect(s.siteName).toBe(DEFAULT_SITE_SETTINGS.siteName);
  });

  it('maps a legacy hoaName onto siteName and drops hoaName', () => {
    const s = normalizeSiteSettings({ hoaName: 'Old Name' });
    expect(s.siteName).toBe('Old Name');
    expect('hoaName' in s).toBe(false);
  });

  it('prefers an explicit siteName over a legacy hoaName', () => {
    expect(
      normalizeSiteSettings({ siteName: 'New', hoaName: 'Old' }).siteName,
    ).toBe('New');
  });

  it('coerces officialMode to a strict boolean', () => {
    expect(normalizeSiteSettings({ officialMode: 'yes' }).officialMode).toBe(
      false,
    );
    expect(normalizeSiteSettings({ officialMode: true }).officialMode).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/site.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/site` / `normalizeSiteSettings` is not exported.

- [ ] **Step 3: Update `src/lib/types.ts`**

Replace the `SiteSettings` interface and `DEFAULT_SITE_SETTINGS` (lines 37–52) with:

```ts
export interface SiteSettings {
  siteName: string;
  tagline: string;
  contactEmail: string; // public contact email (shown on contact page)
  welcomeHeading: string;
  welcomeBody: string;
  /** When true, the site presents as the official HOA site (dues/board surfaces on, disclaimer off). */
  officialMode: boolean;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: 'The Valleys at Ashebrook Residents',
  tagline: 'Welcome to our community',
  contactEmail: '',
  welcomeHeading: 'Welcome to the Valleys at Ashebrook',
  welcomeBody:
    'This is an independent, resident-run website for neighbors in The Valleys at Ashebrook. Here you can read the latest announcements, view the community calendar, and find documents.',
  officialMode: false,
};

/**
 * Coerce a raw parsed settings blob into a complete SiteSettings.
 * Applies the legacy `hoaName` -> `siteName` fallback and a strict boolean for officialMode.
 */
export function normalizeSiteSettings(raw: unknown): SiteSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : fallback;
  const legacyName = typeof r.hoaName === 'string' ? r.hoaName : undefined;
  const name =
    typeof r.siteName === 'string' && r.siteName.trim()
      ? r.siteName
      : (legacyName ?? DEFAULT_SITE_SETTINGS.siteName);
  return {
    siteName: name,
    tagline: str(r.tagline, DEFAULT_SITE_SETTINGS.tagline),
    contactEmail: str(r.contactEmail, DEFAULT_SITE_SETTINGS.contactEmail),
    welcomeHeading: str(r.welcomeHeading, DEFAULT_SITE_SETTINGS.welcomeHeading),
    welcomeBody: str(r.welcomeBody, DEFAULT_SITE_SETTINGS.welcomeBody),
    officialMode: r.officialMode === true,
  };
}
```

- [ ] **Step 4: Create `src/lib/site.ts`**

```ts
// Central branding + site-mode presentation logic.
// Pure module (no server/runtime imports) so it is usable in .astro, React islands, and unit tests.
import type { SiteSettings } from './types';

export const SITE_NAME = 'The Valleys at Ashebrook Residents';
export const NEIGHBORHOOD = 'The Valleys at Ashebrook';
export const OFFICIAL_ORG_NAME = 'Valleys at Ashebrook HOA';

/** One-line disclaimer shown in the footer when official mode is off. */
export const DISCLAIMER_SHORT =
  `Not affiliated with, endorsed by, or operated by the ${OFFICIAL_ORG_NAME} or its board. ` +
  'An independent site built and maintained by a resident of the neighborhood.';

/** Paragraphs for the /about page. */
export const DISCLAIMER_LONG: string[] = [
  `This is an independent, resident-built information hub for neighbors in ${NEIGHBORHOOD}. ` +
    'It gathers announcements, a community calendar, and documents in one place.',
  `It is not affiliated with, endorsed by, or operated by the ${OFFICIAL_ORG_NAME} or its board, ` +
    'and the HOA does not own or control it.',
  'The site runs on a resident’s personal accounts and a personally owned domain, ' +
    'and is built and maintained by that resident on their own initiative.',
  'For official HOA business — dues, governing decisions, or disputes — please contact the ' +
    'HOA or its management company directly.',
  'To reach the resident who maintains this site, use the Contact page.',
];

interface NavLink {
  href: string;
  label: string;
}

const BASE_NAV: NavLink[] = [
  { href: '/', label: 'Home' },
  { href: '/announcements', label: 'Announcements' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/documents', label: 'Documents' },
  { href: '/dues', label: 'Dues' },
  { href: '/contact', label: 'Contact' },
];

type ModeName = Pick<SiteSettings, 'officialMode' | 'siteName'>;

/** Primary nav links; the Dues link only appears in official mode. */
export function navLinks(officialMode: boolean): NavLink[] {
  return officialMode ? BASE_NAV : BASE_NAV.filter((l) => l.href !== '/dues');
}

/** Header sub-brand tag. */
export function brandTag(officialMode: boolean): string {
  return officialMode ? 'Homeowners Association' : 'Residents';
}

/** Name shown in titles + footer copyright: the org name in official mode, else the admin-set site name. */
export function displayName(s: ModeName): string {
  return s.officialMode ? OFFICIAL_ORG_NAME : s.siteName;
}

/** Full <title> string; "Home" gets no suffix separator. */
export function siteTitle(pageTitle: string, s: ModeName): string {
  const name = displayName(s);
  return pageTitle === 'Home' ? name : `${pageTitle} | ${name}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/site.test.ts`
Expected: PASS (9 assertions across the two describes).

- [ ] **Step 6: Type check**

Run: `npm run check`
Expected: no type errors. (If `hoaName` is referenced elsewhere it will surface here — those are handled in later tasks; at this point only `src/lib/content.ts` and `SiteManager.tsx` reference the field via the `SiteSettings` type, which still type-checks because neither reads `.hoaName` directly. If `check` reports a `hoaName` error, note it and fix in the owning task.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/site.ts test/unit/site.test.ts
git commit -m "feat: add branding module + officialMode settings field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Server settings read + API + client read

**Files:**

- Create: `src/server/content/settings.ts`
- Modify: `src/pages/api/content/site.ts`
- Modify: `src/lib/content.ts` (normalize on client read)
- Test: `test/server/site-settings.test.ts`

**Interfaces:**

- Consumes: `getDb` from `src/server/db/client`, `settings` from `src/server/db/schema`, `normalizeSiteSettings`/`DEFAULT_SITE_SETTINGS` from `src/lib/types`.
- Produces: `getSiteSettings(env: Env): Promise<SiteSettings>`.

- [ ] **Step 1: Write the failing test**

Create `test/server/site-settings.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getSiteSettings } from '../../src/server/content/settings';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('getSiteSettings', () => {
  it('returns defaults (official mode off) when no row exists', async () => {
    const s = await getSiteSettings(env);
    expect(s.officialMode).toBe(false);
    expect(s.siteName).toBe(DEFAULT_SITE_SETTINGS.siteName);
  });

  it('normalizes a stored legacy hoaName into siteName', async () => {
    const value = JSON.stringify({
      hoaName: 'Legacy HOA',
      welcomeHeading: 'Hi',
    });
    await getDb(env)
      .insert(settings)
      .values({ key: 'site', value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
    const s = await getSiteSettings(env);
    expect(s.siteName).toBe('Legacy HOA');
    expect(s.welcomeHeading).toBe('Hi');
    expect(s.officialMode).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/site-settings.test.ts`
Expected: FAIL — cannot resolve `../../src/server/content/settings`.

- [ ] **Step 3: Create `src/server/content/settings.ts`**

```ts
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { settings } from '../db/schema';
import {
  DEFAULT_SITE_SETTINGS,
  normalizeSiteSettings,
  type SiteSettings,
} from '../../lib/types';

/** Read + normalize the singleton site settings blob. Fail-closed to defaults (official mode off). */
export async function getSiteSettings(env: Env): Promise<SiteSettings> {
  try {
    const [row] = await getDb(env)
      .select()
      .from(settings)
      .where(eq(settings.key, 'site'));
    if (!row) return { ...DEFAULT_SITE_SETTINGS };
    return normalizeSiteSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_SITE_SETTINGS };
  }
}
```

- [ ] **Step 4: Refactor `src/pages/api/content/site.ts` to delegate**

Replace the whole file with:

```ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSiteSettings } from '../../../server/content/settings';

export const prerender = false;

export const GET: APIRoute = async () => {
  return Response.json(await getSiteSettings(env));
};
```

- [ ] **Step 5: Normalize on the client read in `src/lib/content.ts`**

Add `normalizeSiteSettings` to the type import and use it in `fetchSiteSettings`:

```ts
import {
  type Announcement,
  type DocumentItem,
  type DuesSettings,
  type SiteSettings,
  normalizeSiteSettings,
} from './types';
```

```ts
export async function fetchSiteSettings(): Promise<SiteSettings> {
  const res = await fetch('/api/content/site');
  if (!res.ok) throw new Error(`site ${res.status}`);
  return normalizeSiteSettings(await res.json());
}
```

(The other imports in `content.ts` are currently `import type { … }`; switching to a value import is required because `normalizeSiteSettings` is a runtime value. Keep the type-only names in the same `import { type X, … }` form as shown.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/site-settings.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add src/server/content/settings.ts src/pages/api/content/site.ts src/lib/content.ts test/server/site-settings.test.ts
git commit -m "feat: server getSiteSettings helper with legacy hoaName fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Middleware populates `Astro.locals.site`

**Files:**

- Modify: `src/env.d.ts` (extend `App.Locals`)
- Modify: `src/middleware.ts`
- Test: `test/server/middleware-site.test.ts`

**Interfaces:**

- Consumes: `getSiteSettings` (Task 2), `DEFAULT_SITE_SETTINGS`.
- Produces: `context.locals.site: SiteSettings` on every request (real settings for page requests; defaults for `/api/*`).

- [ ] **Step 1: Write the failing test**

Create `test/server/middleware-site.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { onRequest } from '../../src/middleware';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function ctx(path: string) {
  const url = new URL(`http://localhost${path}`);
  const locals: Record<string, unknown> = {};
  return {
    request: new Request(url),
    url,
    locals,
    redirect: (loc: string, status = 302) =>
      new Response(null, { status, headers: { location: loc } }),
  } as never;
}

describe('middleware site locals', () => {
  it('populates locals.site with defaults (official mode off) for a page request', async () => {
    const c = ctx('/about');
    await onRequest(c, async () => new Response('ok'));
    // @ts-expect-error test shape
    expect(c.locals.site.officialMode).toBe(false);
  });

  it('still populates locals.site for /api requests (defaults, no extra DB read)', async () => {
    const c = ctx('/api/content/site');
    await onRequest(c, async () => new Response('ok'));
    // @ts-expect-error test shape
    expect(c.locals.site).toBeDefined();
    // @ts-expect-error test shape
    expect(c.locals.site.officialMode).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/middleware-site.test.ts`
Expected: FAIL — `c.locals.site` is `undefined`.

- [ ] **Step 3: Extend `App.Locals` in `src/env.d.ts`**

In the `declare namespace App` block, add the `site` member:

```ts
declare namespace App {
  interface Locals extends Runtime {
    authContext: import('./server/authz/guards').AuthContext | null;
    site: import('./lib/types').SiteSettings;
  }
}
```

- [ ] **Step 4: Populate `locals.site` in `src/middleware.ts`**

Add imports and set `context.locals.site` before the redirect checks. The full file becomes:

```ts
// defineMiddleware is an identity function at runtime; avoid the astro:middleware
// virtual module so this file can be imported in both the Astro build and the
// Cloudflare Workers-pool Vitest tests (which do not have astro:middleware available).
import type { MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from './server/authz/context';
import { getSiteSettings } from './server/content/settings';
import { DEFAULT_SITE_SETTINGS } from './lib/types';

export const onRequest: MiddlewareHandler = async (context, next) => {
  const ctx = await getAuthContext(context.request, env);
  context.locals.authContext = ctx;
  const path = context.url.pathname;

  // Surface site settings (incl. officialMode) to page renders. Skip the DB read for
  // API/file routes, which do not render chrome — they get inert defaults.
  context.locals.site = path.startsWith('/api')
    ? { ...DEFAULT_SITE_SETTINGS }
    : await getSiteSettings(env);

  if (path.startsWith('/admin') && ctx?.role !== 'board') {
    return context.redirect('/login', 302);
  }
  if (path.startsWith('/homeowner') && (!ctx || ctx.role === 'visitor')) {
    return context.redirect('/login', 302);
  }
  return next();
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/middleware-site.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/env.d.ts src/middleware.ts test/server/middleware-site.test.ts
git commit -m "feat: expose site settings on Astro.locals via middleware

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Mode-aware site chrome (BaseLayout, Header, Footer)

**Files:**

- Modify: `src/layouts/BaseLayout.astro`
- Modify: `src/components/Header.astro`
- Modify: `src/components/Footer.astro`

**Interfaces:**

- Consumes: `Astro.locals.site` (Task 3); `siteTitle`, `navLinks`, `brandTag`, `displayName`, `DISCLAIMER_SHORT` from `src/lib/site` (Task 1).

_No unit test — `.astro` components are outside the Vitest harness. The mode logic they call is unit-tested in Task 1; this task is verified by `npm run check` + `npm run build` + a manual toggle check._

- [ ] **Step 1: Update `src/layouts/BaseLayout.astro` frontmatter**

Replace lines 1–18 (the imports + `fullTitle` computation) with:

```astro
---
import Header from '../components/Header.astro';
import Footer from '../components/Footer.astro';
import { siteTitle } from '../lib/site';
import '../styles/global.css';

interface Props {
  title: string;
  description?: string;
  /** Render without the public site chrome (used by the admin app). */
  bare?: boolean;
}

const { title, description, bare = false } = Astro.props;
const fullTitle = siteTitle(title, Astro.locals.site);
---
```

- [ ] **Step 2: Update `src/components/Header.astro`**

Replace the frontmatter (lines 1–14) with:

```astro
---
import { navLinks, brandTag } from '../lib/site';

const { pathname } = Astro.url;
const { site } = Astro.locals;
const links = navLinks(site.officialMode);
const tag = brandTag(site.officialMode);

const isCurrent = (href: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href);
---
```

In the markup, change the brand tag line (was `<span class="brand__tag">Homeowners Association</span>`) to:

```astro
<span class="brand__tag">{tag}</span>
```

And change the login link (was `<a class="nav-login" href="/admin">Board Login</a>`) to:

```astro
<a class="nav-login" href="/admin">Admin sign in</a>
```

- [ ] **Step 3: Update `src/components/Footer.astro`**

Replace the whole file with:

```astro
---
import { displayName, DISCLAIMER_SHORT } from '../lib/site';

const year = new Date().getFullYear();
const { site } = Astro.locals;
const name = displayName(site);
---

<footer class="site-footer">
  <span>&copy; {year} {name} &middot; Raleigh, NC</span>
  {
    !site.officialMode && (
      <span class="site-footer__disclaimer">
        {DISCLAIMER_SHORT} <a href="/about">About this site</a>
      </span>
    )
  }
  <a class="site-footer__domain" href="/">ashebrookresidents.com</a>
</footer>
```

- [ ] **Step 4: Add a footer disclaimer style**

Append to `src/styles/global.css` (near the existing `.site-footer` rules — search for `.site-footer` to place it alongside):

```css
.site-footer__disclaimer {
  display: block;
  max-width: 70ch;
  margin: 6px auto 0;
  font-size: 0.8rem;
  line-height: 1.4;
  opacity: 0.75;
}
.site-footer__disclaimer a {
  text-decoration: underline;
}
```

- [ ] **Step 5: Verify type check + build**

Run: `npm run check && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 6: Manual toggle check**

Run: `npm run dev`, open `http://localhost:4321`. Confirm: no "Dues" nav link, brand tag reads "Residents", footer shows the disclaimer + "About this site" link + `ashebrookresidents.com`, and the header login link reads "Admin sign in". (Official-mode-on verification happens in Task 7 once the toggle exists; you can temporarily seed `officialMode:true` via the admin later.)

- [ ] **Step 7: Commit**

```bash
git add src/layouts/BaseLayout.astro src/components/Header.astro src/components/Footer.astro src/styles/global.css
git commit -m "feat: mode-aware header, footer, and title chrome

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: About / disclaimer page

**Files:**

- Create: `src/pages/about.astro`

**Interfaces:**

- Consumes: `DISCLAIMER_LONG`, `NEIGHBORHOOD` from `src/lib/site`.

_No unit test — static page verified by `npm run build` + manual view._

- [ ] **Step 1: Create `src/pages/about.astro`**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import { DISCLAIMER_LONG, NEIGHBORHOOD } from '../lib/site';
---

<BaseLayout
  title="About this site"
  description={`About this independent, resident-run site for ${NEIGHBORHOOD} — and its relationship to the HOA.`}
>
  <div class="page-section">
    <p class="eyebrow">About</p>
    <h1 class="page-title">About this site</h1>
    <div class="prose">
      {DISCLAIMER_LONG.map((para) => <p class="page-lead">{para}</p>)}
    </div>
  </div>
</BaseLayout>
```

- [ ] **Step 2: Verify build + view**

Run: `npm run build`
Expected: succeeds; `/about` route is emitted.
Manual: `npm run dev` → open `http://localhost:4321/about` and confirm all five disclaimer paragraphs render and the footer "About this site" link points here.

- [ ] **Step 3: Commit**

```bash
git add src/pages/about.astro
git commit -m "feat: add /about disclaimer page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Public copy sweep (home, dues, contact, page meta, emails)

**Files:**

- Modify: `src/pages/index.astro`, `src/pages/dues.astro`, `src/pages/contact.astro`
- Modify: `src/components/react/ContactForm.tsx`
- Modify: `src/pages/announcements.astro`, `src/pages/documents.astro`, `src/pages/login.astro`, `src/pages/register.astro`, `src/pages/calendar.astro`
- Modify: `src/server/auth/index.ts`, `src/server/verification/property.ts`

**Interfaces:**

- Consumes: `Astro.locals.site` (for `index.astro`, `dues.astro`, `contact.astro`); `SITE_NAME`, `OFFICIAL_ORG_NAME`, `NEIGHBORHOOD` from `src/lib/site`.

_Mostly copy edits. Verified by `npm run check` + `npm run build`; `ContactForm` change is covered by running the existing jsdom suite. Any test asserting old copy is fixed in this task's Step._

- [ ] **Step 1: Rewrite `src/pages/index.astro` with mode-gated copy**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import AnnouncementsList from '../components/react/AnnouncementsList.tsx';
import { NEIGHBORHOOD } from '../lib/site';

const official = Astro.locals.site.officialMode;
const description = official
  ? 'Official website for the Valleys at Ashebrook Homeowners Association — announcements, community calendar, governing documents, dues, and board contact.'
  : `An independent, resident-run hub for ${NEIGHBORHOOD} — announcements, the community calendar, and documents in one place.`;
---

<BaseLayout title="Home" description={description}>
  <section class="hero">
    <span class="hero__plat hero__plat--a" aria-hidden="true"></span>
    <span class="hero__plat hero__plat--b" aria-hidden="true"></span>
    <div class="hero__inner">
      <p class="eyebrow eyebrow--onnavy">Raleigh, North Carolina</p>
      <h1>A well-kept community, kept simple.</h1>
      {
        official ? (
          <p>
            Announcements, the community calendar, governing documents, and dues
            — all in one place for every Ashebrook homeowner.
          </p>
        ) : (
          <p>
            Announcements, the community calendar, and documents — gathered in
            one place for neighbors in {NEIGHBORHOOD}.
          </p>
        )
      }
      <div class="hero__cta">
        {
          official && (
            <a class="btn btn--light" href="/dues">
              Pay Dues
            </a>
          )
        }
        <a
          class={official ? 'btn btn--ghost-light' : 'btn btn--light'}
          href="/documents">View Documents</a
        >
      </div>
    </div>
  </section>

  <div class="home-grid">
    <div>
      <div class="section-head">
        <h2>Latest Announcements</h2>
        <a class="link-more" href="/announcements">View all →</a>
      </div>
      <AnnouncementsList client:only="react" limit={3} showMoreLink={true} />
    </div>

    <div class="upcoming">
      <h2>Upcoming</h2>
      <div class="cal-note">
        <div class="cal-note__title">Meetings &amp; events</div>
        Community events are posted on our shared Google Calendar. Open any event
        for details and a Google Meet link.
      </div>
      <a class="subscribe-box" href="/calendar"
        >+ Subscribe to the community calendar</a
      >
    </div>
  </div>

  <div class="tiles">
    {
      official && (
        <a class="tile" href="/dues">
          <div class="tile__title">Pay Your Dues →</div>
          <div class="tile__desc">PayPal, Venmo, Zelle, or check.</div>
        </a>
      )
    }
    <a class="tile" href="/documents">
      <div class="tile__title">Documents →</div>
      <div class="tile__desc">Governing documents, minutes, and forms.</div>
    </a>
    <a class="tile" href="/contact">
      <div class="tile__title">Contact →</div>
      {
        official ? (
          <div class="tile__desc">Questions go straight to our inbox.</div>
        ) : (
          <div class="tile__desc">
            Reach the resident who maintains this site.
          </div>
        )
      }
    </a>
  </div>
</BaseLayout>
```

- [ ] **Step 2: Rewrite `src/pages/dues.astro` with the off-mode message**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import DuesInfo from '../components/react/DuesInfo.tsx';
import { OFFICIAL_ORG_NAME } from '../lib/site';

const official = Astro.locals.site.officialMode;
const description = official
  ? 'Annual dues amounts and payment options for the Valleys at Ashebrook HOA.'
  : 'Dues are handled by the HOA — how to reach the board with questions about your dues.';
---

<BaseLayout title="Dues" description={description}>
  <div class="page-section">
    <p class="eyebrow">Payments</p>
    <h1 class="page-title" style="margin-bottom: 36px;">
      Dues &amp; Assessments
    </h1>

    {
      official ? (
        <DuesInfo client:only="react" />
      ) : (
        <p class="page-lead">
          Dues are handled by the {OFFICIAL_ORG_NAME}. This resident-run site
          does not collect payments and is not involved in dues. For questions
          about your dues or a payment, please contact the HOA board directly.
        </p>
      )
    }
  </div>
</BaseLayout>
```

- [ ] **Step 3: Rewrite `src/pages/contact.astro` with mode-gated wording**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import ContactForm from '../components/react/ContactForm.tsx';
import { OFFICIAL_ORG_NAME, NEIGHBORHOOD } from '../lib/site';

const official = Astro.locals.site.officialMode;
---

<BaseLayout
  title="Contact"
  description={official
    ? 'Contact the Valleys at Ashebrook HOA board.'
    : `Contact the resident who maintains this independent ${NEIGHBORHOOD} site.`}
>
  <div class="page-section">
    <p class="eyebrow">Get in touch</p>
    <h1 class="page-title">{official ? 'Contact the Board' : 'Contact'}</h1>
    {
      official ? (
        <p class="page-lead">
          Send a message and it goes straight to the board’s inbox. We typically
          reply within a few days.
        </p>
      ) : (
        <p class="page-lead">
          Send a message and it reaches the resident who maintains this site.
          Note this site is not affiliated with the HOA — for official HOA
          business, contact the HOA or its management company directly.
        </p>
      )
    }

    <div class="contact-grid">
      <ContactForm client:only="react" />

      <aside>
        <div class="contact-aside__h">Other ways to reach us</div>
        <div class="contact-aside__list">
          <div>
            <div class="contact-aside__label">Email</div>
            <div class="contact-aside__val">
              The form reaches the inbox directly — no separate email needed.
            </div>
          </div>
          <div>
            <div class="contact-aside__label">Mail</div>
            <div class="contact-aside__val">
              {official ? OFFICIAL_ORG_NAME : NEIGHBORHOOD}<br />Raleigh, NC
            </div>
          </div>
          {
            official && (
              <div>
                <div class="contact-aside__label">Board meetings</div>
                <div class="contact-aside__val">
                  Quarterly and open to all owners. See the Calendar for the
                  next date.
                </div>
              </div>
            )
          }
        </div>
      </aside>
    </div>
  </div>
</BaseLayout>
```

- [ ] **Step 4: Update `src/components/react/ContactForm.tsx` copy**

Add the import at the top (after the React import):

```tsx
import { SITE_NAME } from '../../lib/site';
```

Change the subject/from lines (were lines 28–31):

```tsx
if (!data.get('subject')) {
  data.set('subject', `New message from the ${SITE_NAME} website`);
}
data.append('from_name', `${SITE_NAME} website`);
```

Change the success paragraph (was "Thank you — the board has received your note and will be in touch soon.") to a mode-agnostic line:

```tsx
<p className="contact-success__p">
  Thanks — your message has been sent. You’ll hear back soon.
</p>
```

- [ ] **Step 5: Update the remaining page meta / calendar copy**

`src/pages/announcements.astro` line 8 description →

```astro
description="Community announcements and news for The Valleys at Ashebrook."
```

`src/pages/documents.astro` line 8 description →

```astro
description="Governing documents, meeting minutes, financials, and forms for The
Valleys at Ashebrook."
```

`src/pages/login.astro` line 8 description →

```astro
description="Sign in to your resident account for The Valleys at Ashebrook."
```

`src/pages/register.astro` line 8 description →

```astro
description="Create an account to access resident resources for The Valleys at
Ashebrook."
```

`src/pages/calendar.astro` — three edits:

- line 24 description → `description="Community calendar for The Valleys at Ashebrook — events and virtual meeting links."`
- line 57 `title="Valleys at Ashebrook HOA community calendar"` → `title="The Valleys at Ashebrook community calendar"`
- line 74 text `Make the HOA Google Calendar public and add its Calendar ID as` → `Make the community Google Calendar public and add its Calendar ID as`

- [ ] **Step 6: Update auth + verification email subjects**

`src/server/auth/index.ts` — add import near the top (with the other imports):

```ts
import { SITE_NAME } from '../../lib/site';
```

Change the two subjects (were lines 45 and 56):

```ts
              `Reset your password — ${SITE_NAME}`,
```

```ts
              `Verify your account — ${SITE_NAME}`,
```

`src/server/verification/property.ts` — add import near the top:

```ts
import { SITE_NAME } from '../../lib/site';
```

Change the subject (was line 65 `'Your HOA verification code'`):

```ts
await sendEmail(
  env,
  owner.email!,
  `Your verification code — ${SITE_NAME}`,
  message,
);
```

- [ ] **Step 7: Run the full jsdom suite + type check + build**

Run: `npm test && npm run check && npm run build`
Expected: PASS. If any existing test asserts old copy (e.g. a ContactForm success-text assertion), update that assertion to the new copy in the same commit. (`DuesInfo.test.tsx` uses `hoa@example.com` only as fixture data and needs no change.)

- [ ] **Step 8: Commit**

```bash
git add src/pages/index.astro src/pages/dues.astro src/pages/contact.astro src/components/react/ContactForm.tsx src/pages/announcements.astro src/pages/documents.astro src/pages/login.astro src/pages/register.astro src/pages/calendar.astro src/server/auth/index.ts src/server/verification/property.ts
git commit -m "feat: rebrand public copy + mode-gate home/dues/contact

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Admin — official-mode toggle + chrome relabel

**Files:**

- Modify: `src/components/admin/SiteManager.tsx`
- Modify: `src/components/admin/AdminApp.tsx`
- Modify: `src/pages/admin/index.astro`
- Modify: `src/components/admin/AdminApp.test.tsx` (update the "Board Admin" assertion)
- Test: `src/components/admin/SiteManager.test.tsx`

**Interfaces:**

- Consumes: `fetchSiteSettings`/`saveSite` (unchanged signatures), `SiteSettings` with `officialMode`.

- [ ] **Step 1: Write the failing test**

Create `src/components/admin/SiteManager.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const saveSite = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  saveSite: (...a: unknown[]) => saveSite(...a),
}));
vi.mock('../../lib/content', () => ({
  fetchSiteSettings: vi.fn().mockResolvedValue({
    siteName: 'The Valleys at Ashebrook Residents',
    tagline: '',
    contactEmail: '',
    welcomeHeading: '',
    welcomeBody: '',
    officialMode: false,
  }),
}));

import SiteManager from './SiteManager';

describe('SiteManager official-mode toggle', () => {
  beforeEach(() => saveSite.mockClear());

  it('renders the toggle off and saves officialMode: true after enabling it', async () => {
    render(<SiteManager />);
    const toggle = await screen.findByRole('checkbox', {
      name: /official mode/i,
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(saveSite).toHaveBeenCalledTimes(1));
    expect(saveSite.mock.calls[0][0]).toMatchObject({ officialMode: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/admin/SiteManager.test.tsx`
Expected: FAIL — no checkbox named "official mode".

- [ ] **Step 3: Add the toggle to `src/components/admin/SiteManager.tsx`**

Immediately after the opening `<form … onSubmit={handleSave}>` `<div className="admin-bar">…</div>` block and the intro `<p>`, insert an official-mode card **above** the existing `panel-card`. Concretely, insert this block right after the `{msg && …}` line and before the existing `<div className="panel-card" …>`:

```tsx
<div className="panel-card" style={{ maxWidth: '620px', marginBottom: '18px' }}>
  <div className="field" style={{ margin: 0 }}>
    <label style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
      <input
        type="checkbox"
        checked={site.officialMode}
        onChange={(e) => setSite({ ...site, officialMode: e.target.checked })}
      />
      <span>Official mode</span>
    </label>
    <p style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>
      When off, the site presents as an unofficial resident-run hub: it shows a
      “not affiliated with the HOA” disclaimer and hides the dues and board
      features. Turn this on only if the HOA board formally adopts this site.
    </p>
  </div>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/admin/SiteManager.test.tsx`
Expected: PASS.

- [ ] **Step 5: Relabel admin chrome**

`src/pages/admin/index.astro` line 6 →

```astro
<BaseLayout title="Site Admin" description="Site administration." bare />
```

`src/components/admin/AdminApp.tsx` line 81 (the `sr-only` heading) →

```tsx
<h1 className="sr-only">Site Admin</h1>
```

- [ ] **Step 6: Update the `AdminApp.test.tsx` assertion**

In `src/components/admin/AdminApp.test.tsx`, the "renders the admin dashboard" test asserts `name: /board admin/i` — change it to match the new heading:

```tsx
expect(
  screen.getByRole('heading', { name: /site admin/i }),
).toBeInTheDocument();
```

(Leave the `/board login/i` assertion untouched — the admin login screen heading is out of scope this round.)

- [ ] **Step 7: Run the admin tests + type check**

Run: `npx vitest run src/components/admin/SiteManager.test.tsx src/components/admin/AdminApp.test.tsx && npm run check`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/admin/SiteManager.tsx src/components/admin/AdminApp.tsx src/pages/admin/index.astro src/components/admin/AdminApp.test.tsx src/components/admin/SiteManager.test.tsx
git commit -m "feat: admin official-mode toggle + de-board admin chrome

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Docs sweep + full verification

**Files:**

- Modify: `.env.example`, `SETUP.md`, `README.md` (drop/soften HOA framing where user-facing; document the officialMode toggle)

**Interfaces:** none (docs + final gate).

_No new automated test; this task runs the full CI gate locally._

- [ ] **Step 1: Update docs**

- `README.md`: reword the project description so it doesn't present the site as the official HOA site; note it's a resident-run site with an admin-toggleable official mode. (Keep technical content.)
- `SETUP.md`: add a short "Official mode" subsection explaining the admin toggle (Site Settings → Official mode) and that it defaults off (unofficial, disclaimer shown). Update any user-facing "HOA" references that describe the public site's identity; leave infra/resource names (`ashebrook-hoa`, `ashebrook-hoa-docs`) and command examples unchanged.
- `.env.example`: no new variable is required (the flag lives in D1). Only adjust a comment if it describes the site as the official HOA site.

Use Grep to find remaining user-facing references to review: `HOA` and `Homeowners Association` across `README.md`, `SETUP.md`, `.env.example`. Skip matches that are resource names, DB names, or wrangler commands.

- [ ] **Step 2: Full local CI gate**

Run: `npm run format` then:
`npm run format:check && npm run check && npm test && npm run test:server && npm run build`
Expected: all pass.

- [ ] **Step 3: Final manual smoke (both modes)**

`npm run dev`:

- Default (official mode off): no Dues nav, "Residents" tag, footer disclaimer + `/about`, `/dues` shows the "contact the HOA board" message, `/contact` says it reaches the site maintainer.
- Sign in to `/admin` → Site Settings → turn **Official mode** on → save → reload the public site: Dues nav returns, "Homeowners Association" tag, "Pay Dues"/"Contact the Board" copy returns, footer disclaimer disappears. Turn it back off.

- [ ] **Step 4: Commit**

```bash
git add README.md SETUP.md .env.example
git commit -m "docs: reflect resident rebrand + official-mode toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Order matters:** Tasks 1→2→3 build the data/plumbing; 4→7 consume `Astro.locals.site` and `src/lib/site`. Do not reorder past a dependency.
- **`.astro` files aren't in the Vitest harness** — their mode logic is unit-tested via `src/lib/site.ts` (Task 1). Tasks 4/5 rely on `check` + `build` + manual view.
- **Do not touch** `wrangler.toml` bindings, Cloudflare resource names, `scripts/import-*.ts`, test fixture IDs, or `design/Ashebrook HOA.dc.html`.
- If `npm run check` flags a stray `hoaName` reference not covered above, it is a real leftover — grep `hoaName` and update it to `siteName`.
