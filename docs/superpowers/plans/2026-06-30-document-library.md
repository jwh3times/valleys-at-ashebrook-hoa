# Tiered Content & Document Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-platform all site content (announcements, documents, dues, site settings) from Firestore onto Cloudflare D1 + R2, add public/homeowner/board visibility tiers to documents and announcements with server-enforced gated file serving, import the Drive archive, and fully remove Firebase.

**Architecture:** Content metadata/text lives in D1 (Drizzle); document files live in an R2 bucket. A single auth-checked Worker route streams files by visibility tier; tier-filtered read endpoints feed the public React islands; board-only admin endpoints (guarded by A's `requireBoard`) do CRUD. `lib/content.ts`/`lib/admin.ts` become thin clients of these endpoints. Builds on sub-project A (branch `feature/document-library` is stacked on `feature/identity-and-roles`).

**Tech Stack:** Astro + `@astrojs/cloudflare` v14, Cloudflare Workers + D1 + R2, Drizzle, Better Auth (A's `getAuthContext`/`requireBoard`), Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Node `>=26.4.0`; npm. Commit after every task on branch `feature/document-library`.
- Route handlers get bindings via `import { env } from 'cloudflare:workers'` — NEVER `locals.runtime.env` (removed in @astrojs/cloudflare v14). API routes set `export const prerender = false`.
- Authorization is ALWAYS server-side. Reads are filtered so a caller never receives content above its tier (`visitor`→public; `homeowner`→public+homeowner; `board`→all). Admin endpoints use `requireBoard` from `src/server/authz/api-guards.ts`.
- Visibility tiers: `Visibility = 'public' | 'homeowner' | 'board'`. Import defaults an unmatched folder path to `board` (fail-safe to most-restricted).
- Worker/D1/R2 tests import `{ env, applyD1Migrations }` from `cloudflare:test`, call `applyD1Migrations(env.DATABASE, env.MIGRATIONS!)` in `beforeAll`, and invoke handlers DIRECTLY (no `SELF.fetch` — Astro-on-Cloudflare has no standalone worker entry). Put worker tests under `test/server/**` (already excluded from the jsdom `npm test` run).
- `request.json()` and `Response.json()` return `unknown` under the worker types — add typed casts at call sites (do not use `any`).
- `npm run check` must end with 0 errors (deprecation hints are fine); `npm test`, `npm run test:server`, and `npm run build` must pass.
- **Run `npm run format` (Prettier `--write`) before committing every task** — CI enforces `npm run format:check` and will fail the pipeline on unformatted files. A repo `.gitattributes` pins line endings to LF, so `format` is safe on Windows.
- Repo style: 2-space indent, single quotes, semicolons (Prettier `.prettierrc.json`).

---

## File Structure

```
wrangler.toml                          # + [[r2_buckets]] binding DOCS
vitest.workers.config.ts               # + r2Buckets: ['DOCS'] in miniflare
src/env.d.ts                           # + DOCS: R2Bucket in Cloudflare.Env
src/lib/types.ts                       # + Visibility; visibility on Announcement/DocumentItem
src/server/db/schema.ts                # + documents, announcements, settings tables
src/server/db/migrations/*             # generated migration
src/server/content/visibility.ts       # tierAllows(role, visibility) + ranks
src/server/content/reads.ts            # tier-filtered D1 fetchers
src/pages/api/files/[id].ts            # gated R2 file streaming
src/pages/api/content/announcements.ts # tier-filtered list
src/pages/api/content/documents.ts     # tier-filtered list
src/pages/api/content/dues.ts          # public dues
src/pages/api/content/site.ts          # public site settings
src/pages/api/admin/documents.ts       # board CRUD + R2 upload
src/pages/api/admin/announcements.ts   # board CRUD
src/pages/api/admin/dues.ts            # board upsert
src/pages/api/admin/site.ts           # board upsert
src/lib/content.ts                     # rewired: fetch /api/content/*
src/lib/admin.ts                       # rewired: fetch /api/admin/*
src/components/admin/*Manager.tsx      # rewired + visibility selectors
scripts/import-documents.ts            # pathToDocMeta + CLI
scripts/doc-tiers.ts                   # folder→visibility/category mapping (shared, unit-tested)
(removed) src/lib/firebase.ts, firestore.rules, storage.rules
SETUP.md, firebase.json, package.json  # Firebase removal
```

---

## Task 1: R2 binding, content schema, Visibility type, migration

**Files:**
- Modify: `wrangler.toml`, `vitest.workers.config.ts`, `src/env.d.ts`, `src/lib/types.ts`
- Modify: `src/server/db/schema.ts`
- Generated: `src/server/db/migrations/*`

**Interfaces:**
- Produces: Drizzle tables `documents`, `announcements`, `settings`; `Visibility` type; `DOCS` R2 binding on `Env`.

- [ ] **Step 1: Add the R2 bucket binding to `wrangler.toml`**

```toml
[[r2_buckets]]
binding = "DOCS"
bucket_name = "ashebrook-hoa-docs"
```

- [ ] **Step 2: Add R2 to the workers test config** — in `vitest.workers.config.ts`, add `r2Buckets: ['DOCS']` alongside the existing `d1Databases`/`kvNamespaces` in the miniflare options.

- [ ] **Step 3: Add `DOCS` to `Cloudflare.Env`** in `src/env.d.ts`:

```ts
DOCS: import('@cloudflare/workers-types').R2Bucket;
```

- [ ] **Step 4: Add the `Visibility` type and fields in `src/lib/types.ts`** — add `export type Visibility = 'public' | 'homeowner' | 'board';` and add `visibility: Visibility` to the `Announcement` and `DocumentItem` interfaces (read the file first; keep the existing `DEFAULT_*` and `DOCUMENT_CATEGORIES` exports).

- [ ] **Step 5: Add the tables to `src/server/db/schema.ts`**

```ts
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] }).notNull().default('board'),
  r2Key: text('r2_key').notNull(),
  filename: text('filename').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  contentType: text('content_type').notNull(),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const announcements = sqliteTable('announcements', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  date: text('date').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] }).notNull().default('public'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 6: Generate + apply the migration locally**

Run: `npm run db:generate && npm run db:migrate:local`
Expected: a new migration SQL includes `documents`, `announcements`, `settings`; local apply succeeds.

- [ ] **Step 7: Type-check**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add R2 binding and D1 schema for tiered content"
```

---

## Task 2: Visibility tier helper

**Files:**
- Create: `src/server/content/visibility.ts`
- Test: `test/unit/visibility.test.ts`

**Interfaces:**
- Produces: `tierAllows(role: Role, visibility: Visibility): boolean` (true iff the role's rank ≥ the visibility's rank; ranks `public=0`, `homeowner=1`, `board=2`; roles `visitor→0`, `homeowner→1`, `board→2`). `visibleTiers(role): Visibility[]`.

- [ ] **Step 1: Write the failing test `test/unit/visibility.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { tierAllows, visibleTiers } from '../../src/server/content/visibility';

describe('tierAllows', () => {
  it('lets each role see its tier and below, not above', () => {
    expect(tierAllows('visitor', 'public')).toBe(true);
    expect(tierAllows('visitor', 'homeowner')).toBe(false);
    expect(tierAllows('homeowner', 'homeowner')).toBe(true);
    expect(tierAllows('homeowner', 'board')).toBe(false);
    expect(tierAllows('board', 'board')).toBe(true);
    expect(tierAllows('board', 'public')).toBe(true);
  });
  it('unknown role sees only public (fail-closed)', () => {
    expect(tierAllows('wat' as never, 'public')).toBe(true);
    expect(tierAllows('wat' as never, 'homeowner')).toBe(false);
  });
  it('visibleTiers lists what a role may see', () => {
    expect(visibleTiers('visitor')).toEqual(['public']);
    expect(visibleTiers('homeowner')).toEqual(['public', 'homeowner']);
    expect(visibleTiers('board')).toEqual(['public', 'homeowner', 'board']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/visibility.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/server/content/visibility.ts`**

```ts
import type { Role } from '../authz/guards';
import type { Visibility } from '../../lib/types';

const VIS_RANK: Record<Visibility, number> = { public: 0, homeowner: 1, board: 2 };
const ROLE_RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

export function tierAllows(role: Role, visibility: Visibility): boolean {
  return (ROLE_RANK[role] ?? 0) >= VIS_RANK[visibility];
}

export function visibleTiers(role: Role): Visibility[] {
  const rank = ROLE_RANK[role] ?? 0;
  return (['public', 'homeowner', 'board'] as Visibility[]).filter((v) => VIS_RANK[v] <= rank);
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run test/unit/visibility.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add visibility tier helper"
```

---

## Task 3: Gated file serving `/api/files/[id]`

**Files:**
- Create: `src/pages/api/files/[id].ts`
- Test: `test/server/files.test.ts`

**Interfaces:**
- Consumes: `getAuthContext` (A), `tierAllows` (Task 2), `getDb` (A), `documents` (Task 1), `env.DOCS` (R2).
- Produces: `GET /api/files/:id` — 404 unknown; public streams to anyone; gated tiers require role ≥ visibility else 403; streams the R2 object with its content type + filename.

- [ ] **Step 1: Write the failing test `test/server/files.test.ts`**

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/files/[id]';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const db = getDb(env);
  const now = new Date();
  await env.DOCS.put('documents/pub/pub.txt', 'public-bytes');
  await env.DOCS.put('documents/hoa/hoa.txt', 'homeowner-bytes');
  await db.insert(documents).values([
    { id: 'doc-pub', title: 'P', category: 'Other', visibility: 'public', r2Key: 'documents/pub/pub.txt', filename: 'pub.txt', sizeBytes: 12, contentType: 'text/plain', uploadedAt: now, updatedAt: now },
    { id: 'doc-hoa', title: 'H', category: 'Other', visibility: 'homeowner', r2Key: 'documents/hoa/hoa.txt', filename: 'hoa.txt', sizeBytes: 15, contentType: 'text/plain', uploadedAt: now, updatedAt: now },
  ]);
});

function ctx(id: string) {
  return { params: { id }, request: new Request(`http://localhost/api/files/${id}`) } as never;
}

describe('file serving', () => {
  it('404s an unknown id', async () => {
    expect((await GET(ctx('nope'))).status).toBe(404);
  });
  it('serves a public file to an anonymous caller', async () => {
    const res = await GET(ctx('doc-pub'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('public-bytes');
  });
  it('403s a homeowner-tier file for an anonymous caller', async () => {
    expect((await GET(ctx('doc-hoa'))).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm run test:server` → FAIL (module not found).

- [ ] **Step 3: Implement `src/pages/api/files/[id].ts`**

```ts
import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { tierAllows } from '../../../server/content/visibility';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const id = params.id!;
  const [doc] = await getDb(env).select().from(documents).where(eq(documents.id, id));
  if (!doc) return new Response('Not Found', { status: 404 });

  if (doc.visibility !== 'public') {
    const ctx = await getAuthContext(request, env);
    const role = ctx?.role ?? 'visitor';
    if (!tierAllows(role, doc.visibility)) return new Response('Forbidden', { status: 403 });
  }

  const object = await env.DOCS.get(doc.r2Key);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  headers.set('content-type', doc.contentType);
  headers.set('content-disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
  headers.set('cache-control', doc.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store');
  return new Response(object.body, { headers });
};
```

- [ ] **Step 4: Run to verify it passes** — `npm run test:server` → the three file tests pass.

- [ ] **Step 5: Type-check + commit**

```bash
npm run check
git add -A
git commit -m "feat: add gated R2 file serving endpoint"
```

---

## Task 4: Tier-filtered content read endpoints

**Files:**
- Create: `src/server/content/reads.ts`, `src/pages/api/content/announcements.ts`, `documents.ts`, `dues.ts`, `site.ts`
- Test: `test/server/content-reads.test.ts`

**Interfaces:**
- Consumes: `getAuthContext` (A), `visibleTiers` (Task 2), `getDb`, tables (Task 1), `DEFAULT_DUES_SETTINGS`/`DEFAULT_SITE_SETTINGS` (`types.ts`).
- Produces:
  - `fetchAnnouncementsFor(env, role, limit?)` → announcements with `visibility ∈ visibleTiers(role)`, pinned-first then date desc.
  - `fetchDocumentsFor(env, role)` → documents with allowed visibility.
  - `GET /api/content/announcements?limit=`, `GET /api/content/documents`, `GET /api/content/dues`, `GET /api/content/site` — each resolves role via `getAuthContext` (anon→visitor) and returns the filtered payload as JSON.

- [ ] **Step 1: Write the failing test `test/server/content-reads.test.ts`**

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET as documentsGet } from '../../src/pages/api/content/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const db = getDb(env);
  const now = new Date();
  await db.insert(documents).values([
    { id: 'd-pub', title: 'P', category: 'Other', visibility: 'public', r2Key: 'k1', filename: 'a', sizeBytes: 1, contentType: 't', uploadedAt: now, updatedAt: now },
    { id: 'd-hoa', title: 'H', category: 'Other', visibility: 'homeowner', r2Key: 'k2', filename: 'b', sizeBytes: 1, contentType: 't', uploadedAt: now, updatedAt: now },
    { id: 'd-brd', title: 'B', category: 'Other', visibility: 'board', r2Key: 'k3', filename: 'c', sizeBytes: 1, contentType: 't', uploadedAt: now, updatedAt: now },
  ]);
});

describe('documents read endpoint', () => {
  it('an anonymous caller sees only public documents', async () => {
    const res = await documentsGet({ request: new Request('http://localhost/api/content/documents') } as never);
    expect(res.status).toBe(200);
    const items = (await res.json()) as { id: string }[];
    expect(items.map((i) => i.id)).toEqual(['d-pub']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm run test:server` → FAIL.

- [ ] **Step 3: Implement `src/server/content/reads.ts`**

```ts
import { inArray, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { announcements, documents } from '../db/schema';
import { visibleTiers } from './visibility';
import type { Role } from '../authz/guards';

export async function fetchDocumentsFor(env: Env, role: Role) {
  return getDb(env).select().from(documents).where(inArray(documents.visibility, visibleTiers(role)));
}

export async function fetchAnnouncementsFor(env: Env, role: Role, limit?: number) {
  const rows = await getDb(env)
    .select().from(announcements)
    .where(inArray(announcements.visibility, visibleTiers(role)))
    .orderBy(desc(announcements.pinned), desc(announcements.date));
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}
```

- [ ] **Step 4: Implement the four endpoints.** Each sets `export const prerender = false`, uses `import { env } from 'cloudflare:workers'`, resolves `const role = (await getAuthContext(request, env))?.role ?? 'visitor'`, and returns JSON. `documents.ts`:

```ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { fetchDocumentsFor } from '../../../server/content/reads';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const role = (await getAuthContext(request, env))?.role ?? 'visitor';
  return Response.json(await fetchDocumentsFor(env, role));
};
```

`announcements.ts` mirrors it, reading `?limit=` from the URL and passing to `fetchAnnouncementsFor`. `dues.ts`/`site.ts` read the `settings` row (`key='dues'`/`'site'`), parse the JSON `value`, and fall back to `DEFAULT_DUES_SETTINGS`/`DEFAULT_SITE_SETTINGS` from `types.ts` when absent — these are public (no tier filter).

- [ ] **Step 5: Run to verify it passes** — `npm run test:server` → the documents read test passes. Then add analogous assertions for announcements if quick; keep the documents test as the required one.

- [ ] **Step 6: Type-check + commit**

```bash
npm run check
git add -A
git commit -m "feat: add tier-filtered content read endpoints"
```

---

## Task 5: Rewire public read helpers + islands to the new endpoints

**Files:**
- Modify: `src/lib/content.ts`
- Modify (if needed): `src/components/react/AnnouncementsList.tsx`, `DocumentsList.tsx`, `DuesInfo.tsx`
- Test: existing `*.test.tsx` for these components must still pass

**Interfaces:**
- Consumes: `/api/content/*` (Task 4).
- Produces: `lib/content.ts` fetch functions that call the endpoints instead of Firestore, keeping their existing exported names/return shapes so the islands are unchanged.

- [ ] **Step 1: Read `src/lib/content.ts` and its consumers** to record the exported function names and return types the islands rely on.

- [ ] **Step 2: Rewire each `content.ts` fetcher** to `fetch('/api/content/<x>')` and return the parsed JSON (typed via `as`), preserving names/shapes. Example:

```ts
export async function fetchDocuments(): Promise<DocumentItem[]> {
  const res = await fetch('/api/content/documents');
  if (!res.ok) throw new Error(`documents ${res.status}`);
  return (await res.json()) as DocumentItem[];
}
```
Do the same for announcements (pass `limit` as a query param), dues, and site. Remove Firestore imports from this file.

- [ ] **Step 3: Update the islands only if their call signatures changed** (they shouldn't if names/shapes are preserved). Ensure the document download links point at `/api/files/<id>`.

- [ ] **Step 4: Update/confirm the component tests** — the existing `AnnouncementsList.test.tsx` / `DocumentsList.test.tsx` / `DuesInfo.test.tsx` mock `lib/content`; ensure they still pass with the rewired module (adjust mocks only if a signature changed). Run `npm test`.

- [ ] **Step 5: Type-check + commit**

```bash
npm run check && npm test
git add -A
git commit -m "feat: rewire public content reads to D1-backed endpoints"
```

---

## Task 6: Admin document endpoints (R2 upload + CRUD) + DocumentsManager

**Files:**
- Create: `src/pages/api/admin/documents.ts`
- Modify: `src/lib/admin.ts` (document functions), `src/components/admin/DocumentsManager.tsx`
- Test: `test/server/admin-documents.test.ts`

**Interfaces:**
- Consumes: `requireBoard` (A), `getDb`, `documents`, `env.DOCS`, `normalizeAddress` not needed here.
- Produces: `POST /api/admin/documents` (multipart: file + title + category + visibility → R2 put + row insert), `PATCH` (id + title/category/visibility), `DELETE` (id → R2 delete + row delete). All board-only.

- [ ] **Step 1: Write the failing test `test/server/admin-documents.test.ts`** — assert `POST` and `DELETE` return 401 for an unauthenticated caller (direct handler invocation), mirroring A's admin-endpoint tests.

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { POST, DELETE } from '../../src/pages/api/admin/documents';

beforeAll(async () => { await applyD1Migrations(env.DATABASE, env.MIGRATIONS!); });

describe('admin documents', () => {
  it('rejects an unauthenticated upload with 401', async () => {
    const res = await POST({ request: new Request('http://localhost/api/admin/documents', { method: 'POST' }) } as never);
    expect(res.status).toBe(401);
  });
  it('rejects an unauthenticated delete with 401', async () => {
    const res = await DELETE({ request: new Request('http://localhost/api/admin/documents', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x' }) }) } as never);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm run test:server` → FAIL.

- [ ] **Step 3: Implement `src/pages/api/admin/documents.ts`**

```ts
import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';

export const prerender = false;
const MAX_BYTES = 25 * 1024 * 1024;

export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env); if (denied) return denied;
  const form = await request.formData();
  const file = form.get('file');
  const title = String(form.get('title') ?? '');
  const category = String(form.get('category') ?? '');
  const visibility = String(form.get('visibility') ?? 'board');
  if (!(file instanceof File) || !title || !category) return new Response('Bad Request', { status: 400 });
  if (file.size > MAX_BYTES) return new Response('Too large', { status: 413 });
  const id = crypto.randomUUID();
  const r2Key = `documents/${id}/${file.name.replace(/[^\w.\-]/g, '_')}`;
  await env.DOCS.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const now = new Date();
  await getDb(env).insert(documents).values({
    id, title, category, visibility: visibility as 'public' | 'homeowner' | 'board',
    r2Key, filename: file.name, sizeBytes: file.size, contentType: file.type || 'application/octet-stream',
    uploadedAt: now, updatedAt: now,
  });
  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env); if (denied) return denied;
  const body = (await request.json()) as { id?: string; title?: string; category?: string; visibility?: string };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['title', 'category', 'visibility'] as const) if (k in body) patch[k] = body[k];
  await getDb(env).update(documents).set(patch).where(eq(documents.id, body.id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env); if (denied) return denied;
  const body = (await request.json()) as { id?: string };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  const [doc] = await getDb(env).select().from(documents).where(eq(documents.id, body.id));
  if (doc) { await env.DOCS.delete(doc.r2Key); await getDb(env).delete(documents).where(eq(documents.id, body.id)); }
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: Run to verify it passes** — `npm run test:server` → the two 401 tests pass.

- [ ] **Step 5: Rewire `lib/admin.ts` document functions + `DocumentsManager.tsx`** — read both files; replace the Firestore/Storage calls with `fetch('/api/admin/documents', ...)` (POST uses `FormData` incl. `visibility`; PATCH/DELETE use JSON). Add a **visibility** select and a metadata **edit** action to `DocumentsManager`. Keep markup consistent with the existing component. Run `npm test` and adjust the component's tests/mocks as needed.

- [ ] **Step 6: Type-check + commit**

```bash
npm run check && npm test && npm run build
git add -A
git commit -m "feat: add board document endpoints (R2 upload) and rewire DocumentsManager with visibility"
```

---

## Task 7: Admin announcements endpoint + AnnouncementsManager

**Files:**
- Create: `src/pages/api/admin/announcements.ts`
- Modify: `src/lib/admin.ts` (announcement functions), `src/components/admin/AnnouncementsManager.tsx`
- Test: `test/server/admin-announcements.test.ts`

**Interfaces:**
- Produces: `POST` (create), `PATCH` (update incl. `visibility`, `pinned`), `DELETE` — board-only, on `announcements`.

- [ ] **Step 1: Failing test** — `test/server/admin-announcements.test.ts`: unauthenticated `POST` → 401 (direct invocation, same shape as Task 6 Step 1).

- [ ] **Step 2: Run to verify it fails** — `npm run test:server` → FAIL.

- [ ] **Step 3: Implement `src/pages/api/admin/announcements.ts`** — same `requireBoard` guard pattern as Task 6; `POST` inserts `{ id: crypto.randomUUID(), title, body, date, pinned, visibility }` (validate `title`/`body`/`date` present → 400 otherwise; default `visibility:'public'`, `pinned:false`); `PATCH` updates allowlisted fields (`title`,`body`,`date`,`pinned`,`visibility`) by `id` (400 if no `id`); `DELETE` removes by `id`. Use `(await request.json()) as {...}` typed casts.

- [ ] **Step 4: Run to verify it passes** — `npm run test:server` → 401 test passes.

- [ ] **Step 5: Rewire `lib/admin.ts` announcement functions + `AnnouncementsManager.tsx`** to the endpoint; add a **visibility** select. Run `npm test`; adjust mocks.

- [ ] **Step 6: Type-check + commit**

```bash
npm run check && npm test
git add -A
git commit -m "feat: add board announcement endpoints and rewire manager with visibility"
```

---

## Task 8: Admin dues + site endpoints + managers

**Files:**
- Create: `src/pages/api/admin/dues.ts`, `src/pages/api/admin/site.ts`
- Modify: `src/lib/admin.ts` (dues/site functions), `src/components/admin/DuesManager.tsx`, `SiteManager.tsx`
- Test: `test/server/admin-settings.test.ts`

**Interfaces:**
- Produces: `PUT /api/admin/dues`, `PUT /api/admin/site` — board-only upsert of the `settings` singleton (`key`, JSON `value`).

- [ ] **Step 1: Failing test** — `test/server/admin-settings.test.ts`: unauthenticated `PUT /api/admin/dues` → 401.

- [ ] **Step 2: Run to verify it fails** — `npm run test:server` → FAIL.

- [ ] **Step 3: Implement both endpoints** — `requireBoard` guard, then upsert:

```ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { settings } from '../../../server/db/schema';

export const prerender = false;

export const PUT: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env); if (denied) return denied;
  const value = JSON.stringify(await request.json());
  await getDb(env).insert(settings).values({ key: 'dues', value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  return new Response(null, { status: 204 });
};
```
`site.ts` is identical with `key: 'site'`.

- [ ] **Step 4: Run to verify it passes** — `npm run test:server` → 401 test passes.

- [ ] **Step 5: Rewire `lib/admin.ts` dues/site functions + `DuesManager.tsx`/`SiteManager.tsx`** to the `PUT` endpoints (send the settings object as JSON). Run `npm test`; adjust mocks.

- [ ] **Step 6: Type-check + commit**

```bash
npm run check && npm test
git add -A
git commit -m "feat: add board dues/site settings endpoints and rewire managers"
```

---

## Task 9: Drive folder→tier mapping + import script

**Files:**
- Create: `scripts/doc-tiers.ts`, `scripts/import-documents.ts`
- Test: `test/unit/doc-tiers.test.ts`

**Interfaces:**
- Produces: `pathToDocMeta(relPath: string): { visibility: Visibility; category: string }` (pure, unit-tested; unmatched → `{ visibility: 'board', category: 'Other' }`); a CLI that walks `private/HOA_files`, uploads to R2, inserts rows (best-effort, operator-run, not executed in tests).

- [ ] **Step 1: Write the failing test `test/unit/doc-tiers.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { pathToDocMeta } from '../../scripts/doc-tiers';

describe('pathToDocMeta', () => {
  it('maps governing docs to public', () => {
    expect(pathToDocMeta('Documents/Governing Documents/By-Laws.pdf').visibility).toBe('public');
  });
  it('maps meeting minutes to homeowner', () => {
    expect(pathToDocMeta('Historical/8-Meetings/Annual/2024/Minutes.docx').visibility).toBe('homeowner');
  });
  it('maps legal/collections to board', () => {
    expect(pathToDocMeta('Historical/7-Legal & Collections/Kornerstone.msg').visibility).toBe('board');
  });
  it('defaults unmatched paths to board (fail-safe)', () => {
    expect(pathToDocMeta('Historical/Something New/x.pdf').visibility).toBe('board');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/doc-tiers.test.ts` → FAIL.

- [ ] **Step 3: Implement `scripts/doc-tiers.ts`**

```ts
import type { Visibility } from '../src/lib/types';

interface Rule { match: RegExp; visibility: Visibility; category: string }

// Order matters: board (most restricted) rules are checked first.
const RULES: Rule[] = [
  { match: /legal|collection|violation|enforcement|correspondence|bank statement|check image|invoice image|financials-board|financials-prelims|contract|tax return|transaction history|delinquen/i, visibility: 'board', category: 'Other' },
  { match: /minutes|meeting|budget|financial|insurance|assessment|collection policy|welcome letter/i, visibility: 'homeowner', category: 'Financials' },
  { match: /gov doc|governing|by-?law|covenant|articles of incorporation|plat|\bmaps?\b|resolution|owner faq|portal|arc form|architectural review form|forms?\b/i, visibility: 'public', category: 'Governing Documents' },
];

export function pathToDocMeta(relPath: string): { visibility: Visibility; category: string } {
  for (const rule of RULES) if (rule.match.test(relPath)) return { visibility: rule.visibility, category: rule.category };
  return { visibility: 'board', category: 'Other' };
}
```
Note: board rules are listed first so sensitive matches win over a looser homeowner/public match; the default is `board`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run test/unit/doc-tiers.test.ts` → PASS.

- [ ] **Step 5: Implement the CLI `scripts/import-documents.ts`** — walks `private/HOA_files/**` (Node `fs`), and for each file calls `pathToDocMeta`, writes to a manifest, and (when run with wrangler/D1/R2 bindings) uploads + inserts. Guard `main()` with `if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])` (cross-platform, per A's fix). Add an npm script `"docs:import"`. Do NOT run it against real files in this task — the unit test covers the mapping. Document the operator run in SETUP.md (Task 11).

- [ ] **Step 6: Type-check + commit**

```bash
npm run check
git add -A
git commit -m "feat: add Drive folder-to-tier mapping and document import script"
```

---

## Task 10: Remove Firebase

**Files:**
- Delete: `src/lib/firebase.ts`, `firestore.rules`, `storage.rules`
- Modify: `package.json` (drop `firebase`), `firebase.json`, `SETUP.md`, `src/components/react/ConfigNotice.tsx` (+ its test), any remaining Firebase imports
- Test: full suite

**Interfaces:**
- Consumes: nothing new. Produces: a Firebase-free codebase.

- [ ] **Step 1: Find every Firebase reference** — `git grep -n -i firebase src/ scripts/ *.json *.rules` (and `firestore`). List each consumer still importing Firebase; all content reads/writes should already be on the API endpoints after Tasks 5–8.

- [ ] **Step 2: Remove the code** — delete `src/lib/firebase.ts`; remove any lingering imports; delete `firestore.rules` and `storage.rules`; remove their entries from `firebase.json` (if `firebase.json` now only held rules/hosting for Firebase, replace it or delete it and note Cloudflare deployment in SETUP.md). Update `ConfigNotice.tsx` to drop the Firebase-config check (or repoint at the new stack) and fix its test.

- [ ] **Step 3: Drop the dependency** — `npm uninstall firebase`.

- [ ] **Step 4: Update `SETUP.md`** — remove the Firebase project / Firestore / Storage / rules steps; add "Create the R2 bucket (`wrangler r2 bucket create ashebrook-hoa-docs`)" and the `docs:import` operator step; keep/adjust the D1/KV/secrets steps from A.

- [ ] **Step 5: Verify the whole suite**

Run: `npm run check && npm test && npm run test:server && npm run build`
Expected: check 0 errors; all tests pass; build completes. Grep confirms no `firebase`/`firestore` imports remain in `src/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove Firebase; site now fully on Cloudflare D1/R2"
```

---

## Self-review notes (coverage against the spec)

- §3 data model → Task 1. §4 R2 → Task 1. §5 gated serving → Task 3 (+ `tierAllows` Task 2). §6 tier-aware reads → Task 4 + Task 5. §7 admin re-platforming → Tasks 6 (documents + visibility + edit), 7 (announcements + visibility), 8 (dues/site). §8 Drive import → Task 9. §9 Firebase removal → Task 10. §10 security → enforced in Tasks 3/4 (server-side filter, board default) + admin guards (6–8). §12 testing → unit (2, 9) + Worker/D1 (3, 4, 6, 7, 8) + component (5, 6–8).
- Deferred per spec (not in this plan): OCR/embeddings/vector search (sub-project C); per-owner private data UI; homeowner uploads.
- Operator-only (needs cloud accounts): `wrangler r2 bucket create`, remote D1 migrate, the `docs:import` run, deploy — documented in SETUP.md (Task 10), consistent with A.
```
