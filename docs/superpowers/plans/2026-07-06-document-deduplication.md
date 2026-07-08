# Document Deduplication & Upload-Time Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicate documents already on the site and prevent new ones, using a SHA-256 exact match plus a metadata-only near-duplicate signal, shared by an upload guard, an admin Duplicates panel, and a bulk cleanup script.

**Architecture:** One pure engine (`src/server/content/dedupe.ts`) computes both signals and groups documents; three surfaces consume it — the `POST /api/admin/documents` upload guard (block exact, warn near), the `GET`/`POST /api/admin/duplicates` panel endpoints (lazy-backfill hashes, report groups, resolve), and a `docs:dedupe` Node script for the one-time bulk cleanup. A new nullable `content_hash` column on `documents` stores the hash.

**Tech Stack:** Astro SSR on `@astrojs/cloudflare` (Cloudflare Workers), D1 via Drizzle ORM, R2 (`DOCS` binding), React (admin islands), Vitest (jsdom unit + `@cloudflare/vitest-pool-workers` server), `crypto.subtle` for hashing.

## Global Constraints

- Node `>=26.4.0`; standalone scripts run via `node --experimental-strip-types scripts/<file>.ts`.
- Every admin write/read endpoint begins with `const denied = await requireBoard(locals, request, env); if (denied) return denied;`.
- Runtime bindings/secrets via `import { env } from 'cloudflare:workers'`. DB via `getDb(env)`.
- `content_hash` is `text`, **nullable**, **not unique**, storing a lowercase-hex SHA-256. The app-level upload guard — not a DB constraint — prevents new exact duplicates.
- Near-duplicate detection is **metadata-only** (normalized filename/title tokens + size proximity + same content-type). `NEAR_THRESHOLD` is a tunable module constant.
- **Auto-collapse only within one visibility tier.** Exact dupes spanning different tiers are surfaced, never auto-deleted. Near-dupes are never auto-acted.
- Visibility values are exactly `'public' | 'homeowner' | 'board'`; document categories come from `DOCUMENT_CATEGORIES`.
- Before pushing: `npm run format`, `npm run check`, `npm test`, `npm run test:server` (CI enforces `format:check`, `check`, `test`, `test:server`, `build`).
- Prettier formatting is enforced; run `npm run format` before each commit.

---

### Task 1: Add `content_hash` column + migration

**Files:**

- Modify: `src/server/db/schema.ts:107-125` (the `documents` table)
- Create: `src/server/db/migrations/0004_<generated-name>.sql` (via `npm run db:generate`)
- Test: `test/server/documents-content-hash.test.ts`

**Interfaces:**

- Produces: `documents.contentHash` (Drizzle column, `content_hash` in SQL) — nullable `string | null`; SQL index `documents_content_hash_idx`.

- [ ] **Step 1: Write the failing test**

Create `test/server/documents-content-hash.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('documents.content_hash column', () => {
  it('stores and reads back a content hash', async () => {
    const now = new Date();
    await getDb(env).insert(documents).values({
      id: 'doc-hash-1',
      title: 'Hashed',
      category: 'Other',
      visibility: 'board',
      r2Key: 'documents/doc-hash-1/x.pdf',
      filename: 'x.pdf',
      sizeBytes: 3,
      contentType: 'application/pdf',
      contentHash: 'abc123',
      uploadedAt: now,
      updatedAt: now,
    });
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'doc-hash-1'));
    expect(row.contentHash).toBe('abc123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/documents-content-hash.test.ts`
Expected: FAIL — TypeScript error / no such column `content_hash` (the property does not exist on the insert type and the migration is absent).

- [ ] **Step 3: Add the column and index to the schema**

In `src/server/db/schema.ts`, add the column after `contentType` (line 119) and the index in the table's index array (lines 123-124):

```ts
    contentType: text('content_type').notNull(),
    contentHash: text('content_hash'),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Public/tier reads filter by visibility; dedup looks up by content hash.
  (t) => [
    index('documents_visibility_idx').on(t.visibility),
    index('documents_content_hash_idx').on(t.contentHash),
  ],
);
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `src/server/db/migrations/0004_<random-name>.sql` and an updated `meta/_journal.json`. Open the generated `.sql` and confirm it contains exactly (order may differ):

```sql
ALTER TABLE `documents` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `documents_content_hash_idx` ON `documents` (`content_hash`);
```

If `db:generate` emits any unrelated statements, stop and reconcile — this task only adds the column and its index.

- [ ] **Step 5: Apply locally and run the test to verify it passes**

Run:

```bash
npm run db:migrate:local
npx vitest run --config vitest.workers.config.ts test/server/documents-content-hash.test.ts
```

Expected: migration applies; test PASSES.

- [ ] **Step 6: Confirm the wider server suite still applies migrations cleanly**

Run: `npm run test:server`
Expected: PASS (the new migration is picked up by the `MIGRATIONS` binding for every server test).

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/server/db/schema.ts src/server/db/migrations/ test/server/documents-content-hash.test.ts
git commit -m "feat(dedupe): add nullable content_hash column + index to documents"
```

---

### Task 2: Dedup engine (`src/server/content/dedupe.ts`)

**Files:**

- Create: `src/server/content/dedupe.ts`
- Test: `test/unit/dedupe.test.ts`

**Interfaces:**

- Consumes: nothing (pure module; uses global `crypto.subtle`).
- Produces:
  - `interface DocLike { id: string; title: string; filename: string; sizeBytes: number; contentType: string; visibility: 'public' | 'homeowner' | 'board'; category?: string; uploadedAt?: number | Date; contentHash?: string | null }`
  - `sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string>`
  - `normalizeName(name: string): string[]`
  - `tokenSimilarity(a: string[], b: string[]): number`
  - `sizeSimilar(a: number, b: number, tolerance?: number): boolean`
  - `nearScore(a: DocLike, b: DocLike): number`
  - `NEAR_THRESHOLD: number`
  - `interface DupeGroup { members: DocLike[]; suggestedKeepId: string; reason?: string }`
  - `suggestedKeepId(members: DocLike[]): string`
  - `groupExact(docs: DocLike[]): DupeGroup[]`
  - `groupNear(docs: DocLike[]): DupeGroup[]`
  - `autoResolvableExact(group: DupeGroup): { keepId: string; deleteIds: string[] } | null`

- [ ] **Step 1: Write the failing test**

Create `test/unit/dedupe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  normalizeName,
  tokenSimilarity,
  sizeSimilar,
  nearScore,
  NEAR_THRESHOLD,
  suggestedKeepId,
  groupExact,
  groupNear,
  autoResolvableExact,
  type DocLike,
} from '../../src/server/content/dedupe';

const doc = (over: Partial<DocLike>): DocLike => ({
  id: 'id',
  title: 't',
  filename: 'f.pdf',
  sizeBytes: 1000,
  contentType: 'application/pdf',
  visibility: 'board',
  ...over,
});

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex (known vector for empty input)', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('is stable and equal for identical byte content', async () => {
    const a = await sha256Hex(new TextEncoder().encode('hello'));
    const b = await sha256Hex(new TextEncoder().encode('hello'));
    expect(a).toBe(b);
  });
});

describe('normalizeName', () => {
  it('strips extension, lowercases, and tokenizes', () => {
    expect(normalizeName('By-Laws.pdf')).toEqual(['by', 'laws']);
  });
  it('strips a (1) copy suffix so a copy matches its original', () => {
    expect(normalizeName('CAMS Settings(1).pdf')).toEqual(
      normalizeName('CAMS Settings.pdf'),
    );
  });
  it('strips a _YYYYMMDD-HHMM timestamp stamp', () => {
    expect(normalizeName('ARC Form_20241216-1453.pdf')).toEqual(
      normalizeName('ARC Form.pdf'),
    );
  });
});

describe('tokenSimilarity', () => {
  it('is 1 for identical token sets', () => {
    expect(tokenSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });
  it('is 0 for disjoint token sets', () => {
    expect(tokenSimilarity(['a'], ['b'])).toBe(0);
  });
});

describe('sizeSimilar', () => {
  it('is true for identical sizes', () => {
    expect(sizeSimilar(1000, 1000)).toBe(true);
  });
  it('is false for sizes well outside tolerance', () => {
    expect(sizeSimilar(1000, 2000)).toBe(false);
  });
});

describe('nearScore', () => {
  it('scores an identical filename in two folders above threshold', () => {
    const a = doc({ id: 'a', title: 'ARC Form', filename: 'ARC Form.pdf' });
    const b = doc({ id: 'b', title: 'ARC Form', filename: 'ARC Form.pdf' });
    expect(nearScore(a, b)).toBeGreaterThanOrEqual(NEAR_THRESHOLD);
  });
  it('scores genuinely different documents below threshold', () => {
    const a = doc({ id: 'a', title: 'By-Laws', filename: 'By-Laws.pdf' });
    const b = doc({
      id: 'b',
      title: 'Articles of Incorporation',
      filename: 'Articles of Incorporation.pdf',
    });
    expect(nearScore(a, b)).toBeLessThan(NEAR_THRESHOLD);
  });
  it('is 0 when content types differ regardless of name', () => {
    const a = doc({ filename: 'Report.pdf', contentType: 'application/pdf' });
    const b = doc({ filename: 'Report.csv', contentType: 'text/csv' });
    expect(nearScore(a, b)).toBe(0);
  });
});

describe('suggestedKeepId', () => {
  it('prefers the clean filename over a (1) copy', () => {
    const clean = doc({ id: 'clean', filename: 'Settings.pdf' });
    const copy = doc({ id: 'copy', filename: 'Settings(1).pdf' });
    expect(suggestedKeepId([copy, clean])).toBe('clean');
  });
});

describe('groupExact', () => {
  it('groups documents that share a content hash, ignoring null hashes', () => {
    const docs = [
      doc({ id: 'a', contentHash: 'h1' }),
      doc({ id: 'b', contentHash: 'h1' }),
      doc({ id: 'c', contentHash: 'h2' }),
      doc({ id: 'd', contentHash: null }),
    ];
    const groups = groupExact(docs);
    expect(groups.length).toBe(1);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
});

describe('groupNear', () => {
  it('groups near-duplicates but excludes exact-hash pairs', () => {
    const docs = [
      doc({
        id: 'a',
        title: 'ARC Form',
        filename: 'ARC Form.pdf',
        contentHash: 'h1',
      }),
      doc({
        id: 'b',
        title: 'ARC Form',
        filename: 'ARC Form.pdf',
        contentHash: 'h1',
      }),
      doc({
        id: 'c',
        title: 'ARC Form',
        filename: 'ARC Form(1).pdf',
        contentHash: 'h2',
      }),
    ];
    const groups = groupNear(docs);
    // a & b are an exact pair (skipped here); c is near a/b by name -> one near group forms
    expect(groups.length).toBe(1);
    expect(groups[0].members.map((m) => m.id)).toContain('c');
  });
});

describe('autoResolvableExact', () => {
  it('returns keep/delete for a same-tier exact group', () => {
    const g = {
      members: [
        doc({ id: 'keep', filename: 'a.pdf', visibility: 'board' }),
        doc({ id: 'drop', filename: 'a(1).pdf', visibility: 'board' }),
      ],
      suggestedKeepId: 'keep',
    };
    expect(autoResolvableExact(g)).toEqual({
      keepId: 'keep',
      deleteIds: ['drop'],
    });
  });
  it('refuses to auto-resolve an exact group spanning tiers', () => {
    const g = {
      members: [
        doc({ id: 'a', visibility: 'public' }),
        doc({ id: 'b', visibility: 'board' }),
      ],
      suggestedKeepId: 'a',
    };
    expect(autoResolvableExact(g)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/dedupe.test.ts`
Expected: FAIL — cannot resolve `../../src/server/content/dedupe`.

- [ ] **Step 3: Write the engine**

Create `src/server/content/dedupe.ts`:

```ts
// Pure duplicate-detection engine shared by the upload guard, the admin
// duplicates panel, and the bulk cleanup script. No I/O — callers supply docs.
export interface DocLike {
  id: string;
  title: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  visibility: 'public' | 'homeowner' | 'board';
  category?: string;
  uploadedAt?: number | Date;
  contentHash?: string | null;
}

export interface DupeGroup {
  members: DocLike[];
  suggestedKeepId: string;
  reason?: string;
}

/** Near-duplicate cutoff for `nearScore`. Tunable; see the metadata weights below. */
export const NEAR_THRESHOLD = 0.6;

/** Lowercase-hex SHA-256 of the given bytes. Works in Workers and Node. */
export async function sha256Hex(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalize a filename/title into comparable tokens: drop the extension, strip
 * copy markers `(1)`/`copy` and timestamp stamps like `_20241216-1453` and
 * trailing `-1`, lowercase, and split on non-alphanumerics. Bare numbers (years,
 * `08`) survive as tokens; only `_`/`-`-prefixed number runs are treated as stamps.
 */
export function normalizeName(name: string): string[] {
  const noExt = name.replace(/\.[^.]+$/, '');
  const stripped = noExt
    .toLowerCase()
    .replace(/\(\d+\)/g, ' ')
    .replace(/\bcopy\b/g, ' ')
    .replace(/[_-]?\d{8}-\d{4}\b/g, ' ')
    .replace(/[_-]\d+\b/g, ' ');
  return stripped.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Sørensen–Dice coefficient over the two token *sets*, in [0,1]. */
export function tokenSimilarity(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

/** True when two byte sizes are within `tolerance` (fraction) of each other. */
export function sizeSimilar(a: number, b: number, tolerance = 0.05): boolean {
  if (a === b) return true;
  const larger = Math.max(a, b);
  if (larger === 0) return true;
  return Math.abs(a - b) / larger <= tolerance;
}

/**
 * Metadata-only similarity in [0,1]. Same content-type is required (different
 * types are never near-duplicates); score is name-token similarity plus a small
 * boost when sizes are close.
 */
export function nearScore(a: DocLike, b: DocLike): number {
  if (a.contentType !== b.contentType) return 0;
  const nameSim = tokenSimilarity(
    normalizeName(`${a.title} ${a.filename}`),
    normalizeName(`${b.title} ${b.filename}`),
  );
  const sizeBoost = sizeSimilar(a.sizeBytes, b.sizeBytes) ? 0.2 : 0;
  return Math.min(1, nameSim + sizeBoost);
}

/** Cleanest filename wins: no copy/timestamp marker, then shortest, then oldest. */
export function suggestedKeepId(members: DocLike[]): string {
  const rank = (d: DocLike) => ({
    marked:
      /\(\d+\)/.test(d.filename) || /\d{8}-\d{4}/.test(d.filename) ? 1 : 0,
    len: d.filename.length,
    when:
      typeof d.uploadedAt === 'number'
        ? d.uploadedAt
        : d.uploadedAt instanceof Date
          ? d.uploadedAt.getTime()
          : Number.MAX_SAFE_INTEGER,
  });
  return [...members].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra.marked - rb.marked || ra.len - rb.len || ra.when - rb.when;
  })[0].id;
}

/** Group documents by identical content hash (null hashes ignored). Size >= 2. */
export function groupExact(docs: DocLike[]): DupeGroup[] {
  const byHash = new Map<string, DocLike[]>();
  for (const d of docs) {
    if (!d.contentHash) continue;
    const arr = byHash.get(d.contentHash) ?? [];
    arr.push(d);
    byHash.set(d.contentHash, arr);
  }
  const groups: DupeGroup[] = [];
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    groups.push({ members, suggestedKeepId: suggestedKeepId(members) });
  }
  return groups;
}

/**
 * Group near-duplicates via connected components over pairs scoring at/above
 * `NEAR_THRESHOLD`. Pairs already identical by content hash are skipped — they
 * belong to `groupExact`, not here.
 */
export function groupNear(docs: DocLike[]): DupeGroup[] {
  const n = docs.length;
  const parent = docs.map((_, i) => i);
  const find = (x: number): number =>
    parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const hi = docs[i].contentHash;
      if (hi && hi === docs[j].contentHash) continue;
      if (nearScore(docs[i], docs[j]) >= NEAR_THRESHOLD) union(i, j);
    }
  }
  const byRoot = new Map<number, DocLike[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(docs[i]);
    byRoot.set(r, arr);
  }
  const groups: DupeGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    groups.push({
      members,
      suggestedKeepId: suggestedKeepId(members),
      reason: 'similar filename/size',
    });
  }
  return groups;
}

/**
 * Safety rule: an exact group may be auto-collapsed only when every member
 * shares one visibility tier (the surviving copy is byte-identical, so no data
 * loss). Cross-tier groups return null — they need a human decision.
 */
export function autoResolvableExact(
  group: DupeGroup,
): { keepId: string; deleteIds: string[] } | null {
  const tiers = new Set(group.members.map((m) => m.visibility));
  if (tiers.size !== 1) return null;
  const keepId = group.suggestedKeepId;
  const deleteIds = group.members
    .filter((m) => m.id !== keepId)
    .map((m) => m.id);
  return { keepId, deleteIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/dedupe.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/server/content/dedupe.ts test/unit/dedupe.test.ts
git commit -m "feat(dedupe): add pure duplicate-detection engine"
```

---

### Task 3: Upload guard — block exact, warn near

**Files:**

- Modify: `src/pages/api/admin/documents.ts` (the `POST` handler, lines 30-72)
- Test: `test/server/admin-documents-dedupe.test.ts`

**Interfaces:**

- Consumes: `sha256Hex`, `nearScore`, `NEAR_THRESHOLD`, `DocLike` from `src/server/content/dedupe`; `documents.contentHash` (Task 1).
- Produces (HTTP contract for the client in Task 4):
  - Exact match → `409` JSON `{ error: 'exact-duplicate', existing: { id, title, category, visibility } }`, nothing written.
  - Near match (when form field `confirmDuplicate !== 'true'`) → `409` JSON `{ warning: 'near-duplicate', similar: [{ id, title, filename, category, visibility }] }`, nothing written.
  - Clean or confirmed → `201`, row inserted **with `contentHash`**.

- [ ] **Step 1: Write the failing test**

Create `test/server/admin-documents-dedupe.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST } from '../../src/pages/api/admin/documents';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function upload(
  content: string,
  name: string,
  title: string,
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  form.set('file', new File([content], name, { type: 'application/pdf' }));
  form.set('title', title);
  form.set('category', 'Governing Documents');
  form.set('visibility', 'public');
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return POST({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'POST',
      body: form,
    }),
  } as never);
}

describe('upload guard', () => {
  it('persists a content hash on a clean upload', async () => {
    const res = await upload('unique-alpha', 'alpha.pdf', 'Alpha');
    expect(res.status).toBe(201);
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.title, 'Alpha'));
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks a byte-identical re-upload with 409 exact-duplicate', async () => {
    await upload('same-bytes-here', 'first.pdf', 'First');
    const res = await upload('same-bytes-here', 'second.pdf', 'Second');
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      existing: { title: string };
    };
    expect(body.error).toBe('exact-duplicate');
    expect(body.existing.title).toBe('First');
    // Nothing inserted for the blocked upload.
    const rows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.title, 'Second'));
    expect(rows.length).toBe(0);
  });

  it('warns on a near-duplicate, then accepts with confirmDuplicate=true', async () => {
    await upload(
      'body-one',
      'Meeting Minutes 2024.pdf',
      'Meeting Minutes 2024',
    );
    const warn = await upload(
      'body-two-different',
      'Meeting Minutes 2024.pdf',
      'Meeting Minutes 2024',
    );
    expect(warn.status).toBe(409);
    const wbody = (await warn.json()) as {
      warning: string;
      similar: unknown[];
    };
    expect(wbody.warning).toBe('near-duplicate');
    expect(wbody.similar.length).toBeGreaterThan(0);

    const ok = await upload(
      'body-two-different',
      'Meeting Minutes 2024.pdf',
      'Meeting Minutes 2024',
      { confirmDuplicate: 'true' },
    );
    expect(ok.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-documents-dedupe.test.ts`
Expected: FAIL — clean upload has no `contentHash` (null), and the guard does not yet return 409.

- [ ] **Step 3: Add the guard to the POST handler**

In `src/pages/api/admin/documents.ts`, update the import block (after line 8) to add the engine:

```ts
import { DOCUMENT_CATEGORIES, INPUT_LIMITS } from '../../../lib/types';
import {
  sha256Hex,
  nearScore,
  NEAR_THRESHOLD,
  type DocLike,
} from '../../../server/content/dedupe';
```

Then replace the tail of `POST` (from `if (!contentType)` through the insert, lines 49-71) with:

```ts
  if (!contentType)
    return new Response('Unsupported file type', { status: 415 });

  const bytes = await file.arrayBuffer();
  const contentHash = await sha256Hex(bytes);
  const db = getDb(env);

  // Block a byte-identical re-upload — the exact copy is already on the site.
  const [exact] = await db
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
    })
    .from(documents)
    .where(eq(documents.contentHash, contentHash));
  if (exact) {
    return Response.json(
      { error: 'exact-duplicate', existing: exact },
      { status: 409 },
    );
  }

  // Warn on a metadata near-duplicate unless the board explicitly confirmed.
  const confirmDuplicate = String(form.get('confirmDuplicate') ?? '') === 'true';
  if (!confirmDuplicate) {
    const existing = await db
      .select({
        id: documents.id,
        title: documents.title,
        filename: documents.filename,
        sizeBytes: documents.sizeBytes,
        contentType: documents.contentType,
        category: documents.category,
        visibility: documents.visibility,
      })
      .from(documents);
    const candidate: DocLike = {
      id: 'new',
      title,
      filename: file.name,
      sizeBytes: file.size,
      contentType,
      visibility: visibility as DocLike['visibility'],
    };
    const similar = existing
      .filter((e) => nearScore(candidate, e as DocLike) >= NEAR_THRESHOLD)
      .map((e) => ({
        id: e.id,
        title: e.title,
        filename: e.filename,
        category: e.category,
        visibility: e.visibility,
      }));
    if (similar.length > 0) {
      return Response.json(
        { warning: 'near-duplicate', similar },
        { status: 409 },
      );
    }
  }

  const id = crypto.randomUUID();
  const r2Key = `documents/${id}/${file.name.replace(/[^\w.\-]/g, '_')}`;
  await env.DOCS.put(r2Key, bytes, {
    httpMetadata: { contentType },
  });
  const now = new Date();
  await db.insert(documents).values({
    id,
    title,
    category,
    visibility: visibility as 'public' | 'homeowner' | 'board',
    r2Key,
    filename: file.name,
    sizeBytes: file.size,
    contentType,
    contentHash,
    uploadedAt: now,
    updatedAt: now,
  });
  return new Response(null, { status: 201 });
};
```

Note: the old `id`/`r2Key` declarations at lines 51-52 are now inside this block — ensure there is exactly one declaration of each (delete the originals if this replaces only part of the handler).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-documents-dedupe.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm existing document tests still pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-documents.test.ts test/server/admin-documents-board.test.ts`
Expected: PASS (clean uploads still 201; unrelated titles are not near-duplicates).

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/pages/api/admin/documents.ts test/server/admin-documents-dedupe.test.ts
git commit -m "feat(dedupe): block exact + warn near on document upload"
```

---

### Task 4: Client helpers — `DuplicateError`, `confirmDuplicate`, duplicates API

**Files:**

- Modify: `src/lib/admin.ts` (documents section, lines 44-61; add duplicates helpers)
- Modify: `src/lib/types.ts` (add duplicate view types near `DocumentItem`, after line 22)
- Test: `test/unit/dedupe-client.test.ts`

**Interfaces:**

- Consumes: the HTTP contracts from Tasks 3 and 6.
- Produces:
  - `class DuplicateError extends Error` with `kind: 'exact' | 'near'`, `existing?`, `similar?`.
  - `uploadDocument(file, title, category, visibility?, confirmDuplicate?)` — throws `DuplicateError` on a 409.
  - `fetchDuplicates(): Promise<DuplicatesView>`, `resolveDuplicates(keepId, deleteIds): Promise<void>`.
  - Types `DupeMember`, `DupeGroupView`, `DuplicatesView` in `types.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/dedupe-client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  uploadDocument,
  resolveDuplicates,
  DuplicateError,
} from '../../src/lib/admin';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }),
  );
}

const file = () => new File(['x'], 'a.pdf', { type: 'application/pdf' });

describe('uploadDocument duplicate handling', () => {
  it('throws a DuplicateError(kind=exact) on a 409 exact-duplicate', async () => {
    mockFetch(409, {
      error: 'exact-duplicate',
      existing: {
        id: '1',
        title: 'Existing',
        category: 'Other',
        visibility: 'board',
      },
    });
    await expect(
      uploadDocument(file(), 'T', 'Other', 'board'),
    ).rejects.toMatchObject({ kind: 'exact' });
  });

  it('throws a DuplicateError(kind=near) on a 409 near-duplicate', async () => {
    mockFetch(409, {
      warning: 'near-duplicate',
      similar: [{ id: '2', title: 'Close' }],
    });
    await expect(
      uploadDocument(file(), 'T', 'Other', 'board'),
    ).rejects.toMatchObject({ kind: 'near' });
  });

  it('sets confirmDuplicate on the form when confirmed', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', f);
    await uploadDocument(file(), 'T', 'Other', 'board', true);
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get('confirmDuplicate')).toBe('true');
  });
});

describe('resolveDuplicates', () => {
  it('POSTs a resolve action with keep/delete ids', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', f);
    await resolveDuplicates('keep', ['drop1', 'drop2']);
    const [, init] = f.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'resolve',
      keepId: 'keep',
      deleteIds: ['drop1', 'drop2'],
    });
  });
});

describe('DuplicateError', () => {
  it('is an Error subclass carrying its kind', () => {
    const e = new DuplicateError('exact', { existing: { id: '1' } });
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('exact');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/dedupe-client.test.ts`
Expected: FAIL — `DuplicateError`, `resolveDuplicates`, and the new `uploadDocument` signature do not exist.

- [ ] **Step 3: Add the view types**

In `src/lib/types.ts`, after the `DocumentItem` interface (line 22), add:

```ts
export interface DupeMember {
  id: string;
  title: string;
  filename: string;
  category: string;
  visibility: Visibility;
  sizeBytes: number;
  uploadedAt: string; // ISO
}

export interface DupeGroupView {
  members: DupeMember[];
  suggestedKeepId: string;
  reason?: string;
}

export interface DuplicatesView {
  exact: DupeGroupView[];
  near: DupeGroupView[];
  remaining: number;
}
```

- [ ] **Step 4: Update `admin.ts`**

In `src/lib/admin.ts`, add `DuplicatesView` to the type import (lines 2-9):

```ts
import type {
  Announcement,
  DuesSettings,
  SiteSettings,
  PropertyWithOwners,
  MembersView,
  MemberUser,
  DuplicatesView,
} from './types';
```

Replace `uploadDocument` (lines 45-61) and add the duplicates helpers + error class:

```ts
export class DuplicateError extends Error {
  kind: 'exact' | 'near';
  existing?: {
    id: string;
    title: string;
    category: string;
    visibility: string;
  };
  similar?: {
    id: string;
    title: string;
    filename: string;
    category: string;
    visibility: string;
  }[];
  constructor(
    kind: 'exact' | 'near',
    payload: {
      existing?: DuplicateError['existing'];
      similar?: DuplicateError['similar'];
    },
  ) {
    super(kind === 'exact' ? 'exact-duplicate' : 'near-duplicate');
    this.name = 'DuplicateError';
    this.kind = kind;
    this.existing = payload.existing;
    this.similar = payload.similar;
  }
}

export async function uploadDocument(
  file: File,
  title: string,
  category: string,
  visibility: string = 'board',
  confirmDuplicate: boolean = false,
): Promise<void> {
  const form = new FormData();
  form.set('file', file);
  form.set('title', title);
  form.set('category', category);
  form.set('visibility', visibility);
  if (confirmDuplicate) form.set('confirmDuplicate', 'true');
  const res = await fetch('/api/admin/documents', {
    method: 'POST',
    body: form,
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      warning?: string;
      existing?: DuplicateError['existing'];
      similar?: DuplicateError['similar'];
    };
    if (body.error === 'exact-duplicate')
      throw new DuplicateError('exact', { existing: body.existing });
    if (body.warning === 'near-duplicate')
      throw new DuplicateError('near', { similar: body.similar });
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

export async function fetchDuplicates(): Promise<DuplicatesView> {
  const res = await fetch('/api/admin/duplicates');
  if (!res.ok) throw new Error(`duplicates ${res.status}`);
  return (await res.json()) as DuplicatesView;
}

export async function resolveDuplicates(
  keepId: string,
  deleteIds: string[],
): Promise<void> {
  const res = await fetch('/api/admin/duplicates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', keepId, deleteIds }),
  });
  if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/dedupe-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/lib/admin.ts src/lib/types.ts test/unit/dedupe-client.test.ts
git commit -m "feat(dedupe): client DuplicateError, confirmDuplicate, duplicates API helpers"
```

---

### Task 5: DocumentsManager — near-warn / exact-block upload UX

**Files:**

- Modify: `src/components/admin/DocumentsManager.tsx` (imports; upload state/handlers lines 44-103; upload form button line 266; add warning banner)
- Modify: `src/components/admin/DocumentsManager.test.tsx` (mock must export `DuplicateError`)
- Test: `src/components/admin/DocumentsManager.test.tsx` (add near/exact cases)

**Interfaces:**

- Consumes: `uploadDocument`, `DuplicateError` from `../../lib/admin`.

- [ ] **Step 1: Update the mock and add failing tests**

In `src/components/admin/DocumentsManager.test.tsx`, replace the `vi.mock('../../lib/admin', …)` block (lines 4-9) so the mocked module also exports a faithful `DuplicateError` (the component checks `instanceof`):

```ts
const uploadDocument = vi.fn().mockResolvedValue(undefined);
class DuplicateError extends Error {
  kind: 'exact' | 'near';
  existing?: {
    id: string;
    title: string;
    category: string;
    visibility: string;
  };
  similar?: { id: string; title: string; filename: string }[];
  constructor(kind: 'exact' | 'near', payload: Record<string, unknown>) {
    super(kind);
    this.name = 'DuplicateError';
    this.kind = kind;
    Object.assign(this, payload);
  }
}
vi.mock('../../lib/admin', () => ({
  uploadDocument: (...a: unknown[]) => uploadDocument(...a),
  editDocument: vi.fn(),
  deleteDocument: vi.fn(),
  DuplicateError,
}));
```

Then append a new describe block at the end of the file:

```ts
describe('DocumentsManager duplicate handling', () => {
  beforeEach(() => uploadDocument.mockReset());

  function fillAndSubmit() {
    fireEvent.change(screen.getByPlaceholderText(/bylaws/i), {
      target: { value: 'Minutes' },
    });
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'minutes.pdf', { type: 'application/pdf' })] },
    });
    submitForm();
  }

  it('shows a blocking message on an exact duplicate and offers no override', async () => {
    uploadDocument.mockRejectedValueOnce(
      new DuplicateError('exact', {
        existing: { id: '1', title: 'Existing Minutes', category: 'Other', visibility: 'board' },
      }),
    );
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText(/already on the site/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: /upload anyway/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an "Upload anyway" action on a near duplicate and re-submits confirmed', async () => {
    uploadDocument
      .mockRejectedValueOnce(
        new DuplicateError('near', {
          similar: [{ id: '2', title: 'Close Minutes', filename: 'close.pdf' }],
        }),
      )
      .mockResolvedValueOnce(undefined);
    render(<DocumentsManager />);
    await screen.findByText(/upload a document/i);
    fillAndSubmit();
    const anyway = await screen.findByRole('button', { name: /upload anyway/i });
    fireEvent.click(anyway);
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(2));
    // Second call passes confirmDuplicate=true (5th arg).
    expect(uploadDocument.mock.calls[1][4]).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/admin/DocumentsManager.test.tsx`
Expected: FAIL — no "already on the site" message and no "Upload anyway" button exist yet.

- [ ] **Step 3: Update the component**

In `src/components/admin/DocumentsManager.tsx`:

Update the imports (lines 2-3):

```ts
import { fetchDocuments } from '../../lib/content';
import {
  deleteDocument,
  editDocument,
  uploadDocument,
  DuplicateError,
} from '../../lib/admin';
```

Add near-warning state alongside the other upload state (after line 57, `const [file, setFile] = …`):

```ts
const [uploading, setUploading] = useState(false);
const [dupWarning, setDupWarning] = useState<{
  similar: { id: string; title: string; filename: string }[];
} | null>(null);
```

Replace `handleUpload` (lines 82-103) with a shared submit routine:

```ts
async function submitUpload(confirmDuplicate: boolean) {
  if (!file) {
    setMsg('Please choose a file.');
    return;
  }
  setMsg('');
  setUploading(true);
  try {
    await uploadDocument(file, title, category, visibility, confirmDuplicate);
    setDupWarning(null);
    setTitle('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    await reload();
    setMsg('Document uploaded.');
  } catch (err: unknown) {
    if (err instanceof DuplicateError && err.kind === 'exact') {
      setDupWarning(null);
      setMsg(
        `Error: This exact file is already on the site as “${err.existing?.title ?? 'an existing document'}”. Nothing was uploaded.`,
      );
    } else if (err instanceof DuplicateError && err.kind === 'near') {
      setDupWarning({ similar: err.similar ?? [] });
    } else {
      setDupWarning(null);
      setMsg(
        'Error: ' +
          ((err as { message?: string } | null)?.message ??
            'could not upload.'),
      );
    }
  } finally {
    setUploading(false);
  }
}

async function handleUpload(e: React.FormEvent) {
  e.preventDefault();
  if (!file) {
    setMsg('Please choose a file.');
    return;
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    setMsg(
      'Unsupported file type. Allowed: PDF, Word, Excel, CSV, text, Markdown.',
    );
    return;
  }
  setDupWarning(null);
  await submitUpload(false);
}
```

Change the upload button to use `uploading` (line 266) inside the upload `<form>`:

```tsx
<div className="btn-row">
  <button className="btn btn--small" type="submit" disabled={uploading}>
    {uploading ? 'Uploading…' : 'Upload document'}
  </button>
</div>
```

Add the warning banner immediately after that `<div className="btn-row">…</div>`, before the form closes (before line 270 `</form>`):

```tsx
{
  dupWarning && (
    <div className="form-message" style={{ marginTop: '12px' }} role="alert">
      <p style={{ margin: '0 0 8px' }}>
        A similar document is already on the site:
      </p>
      <ul style={{ margin: '0 0 10px 18px' }}>
        {dupWarning.similar.map((s) => (
          <li key={s.id}>
            {s.title} <span className="muted">({s.filename})</span>
          </li>
        ))}
      </ul>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--small"
          disabled={uploading}
          onClick={() => submitUpload(true)}
        >
          Upload anyway
        </button>
        <button
          type="button"
          className="btn btn--outline btn--small"
          onClick={() => setDupWarning(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/admin/DocumentsManager.test.tsx`
Expected: PASS (both existing and new cases).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/components/admin/DocumentsManager.tsx src/components/admin/DocumentsManager.test.tsx
git commit -m "feat(dedupe): near-warn/exact-block upload UX in DocumentsManager"
```

---

### Task 6: Duplicates endpoint — `GET` (backfill + report) and `POST` (resolve)

**Files:**

- Create: `src/pages/api/admin/duplicates.ts`
- Test: `test/server/admin-duplicates.test.ts` (unauthenticated gate)
- Test: `test/server/admin-duplicates-board.test.ts` (board: backfill/report/resolve)

**Interfaces:**

- Consumes: `requireBoard`; `getDb`; `documents`; `sha256Hex`, `groupExact`, `groupNear`, `DocLike`, `DupeGroup` from the engine.
- Produces:
  - `GET /api/admin/duplicates` → `{ exact: GroupView[], near: GroupView[], remaining: number }` where `GroupView = { members: {id,title,filename,category,visibility,sizeBytes,uploadedAt}[], suggestedKeepId, reason? }`.
  - `POST /api/admin/duplicates` with `{ action:'resolve', keepId, deleteIds }` → `204`; deletes each `deleteId` from R2 + D1.

- [ ] **Step 1: Write the failing tests**

Create the unauthenticated gate test `test/server/admin-duplicates.test.ts` (no context mock — the guard must fail closed), mirroring `test/server/admin-documents.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET, POST } from '../../src/pages/api/admin/duplicates';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin duplicates — gate', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await GET({
      request: new Request('http://localhost/api/admin/duplicates'),
    } as never);
    expect(res.status).toBe(401);
  });
  it('rejects an unauthenticated resolve with 401', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/duplicates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'resolve',
          keepId: 'x',
          deleteIds: ['y'],
        }),
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});
```

Then create the board-session test `test/server/admin-duplicates-board.test.ts` (mocks the auth context to a board member, mirroring `test/server/admin-documents-board.test.ts`):

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET, POST } from '../../src/pages/api/admin/duplicates';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function seed(
  id: string,
  content: string,
  filename: string,
  hash: string | null,
) {
  const key = `documents/${id}/${filename}`;
  await env.DOCS.put(key, content);
  const now = new Date();
  await getDb(env)
    .insert(documents)
    .values({
      id,
      title: filename.replace(/\.[^.]+$/, ''),
      category: 'Other',
      visibility: 'board',
      r2Key: key,
      filename,
      sizeBytes: content.length,
      contentType: 'application/pdf',
      contentHash: hash,
      uploadedAt: now,
      updatedAt: now,
    });
}

const call = (fn: typeof GET, method: string, body?: unknown) =>
  fn({
    request: new Request('http://localhost/api/admin/duplicates', {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  } as never);

describe('admin duplicates — board', () => {
  it('lazy-backfills hashes and reports an exact group', async () => {
    await seed('d1', 'identical-bytes', 'a.pdf', null);
    await seed('d2', 'identical-bytes', 'a(1).pdf', null);
    const res = await call(GET, 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exact: { members: { id: string }[]; suggestedKeepId: string }[];
      remaining: number;
    };
    const group = body.exact.find((g) => g.members.some((m) => m.id === 'd1'));
    expect(group).toBeTruthy();
    expect(group!.members.map((m) => m.id).sort()).toEqual(['d1', 'd2']);
    expect(group!.suggestedKeepId).toBe('d1'); // clean filename wins
    const [row] = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'd1'));
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a group by deleting the extras from D1 and R2', async () => {
    await seed('keep', 'keep-bytes', 'keep.pdf', 'kh');
    await seed('drop', 'drop-bytes', 'drop.pdf', 'dh');
    const res = await call(POST, 'POST', {
      action: 'resolve',
      keepId: 'keep',
      deleteIds: ['drop'],
    });
    expect(res.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'drop'));
    expect(rows.length).toBe(0);
    expect(await env.DOCS.get('documents/drop/drop.pdf')).toBeNull();
    const keepRows = await getDb(env)
      .select()
      .from(documents)
      .where(eq(documents.id, 'keep'));
    expect(keepRows.length).toBe(1);
  });

  it('rejects a resolve missing keepId', async () => {
    const res = await call(POST, 'POST', {
      action: 'resolve',
      deleteIds: ['x'],
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-duplicates.test.ts test/server/admin-duplicates-board.test.ts`
Expected: FAIL — cannot resolve `../../src/pages/api/admin/duplicates`.

- [ ] **Step 3: Write the endpoint**

Create `src/pages/api/admin/duplicates.ts`:

```ts
import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';
import {
  sha256Hex,
  groupExact,
  groupNear,
  type DocLike,
  type DupeGroup,
} from '../../../server/content/dedupe';

export const prerender = false;

// Cap hashing per request so a cold call over the whole archive stays within
// Worker CPU/subrequest limits; the client polls until `remaining` is 0.
const BACKFILL_CAP = 25;

function serialize(group: DupeGroup) {
  return {
    suggestedKeepId: group.suggestedKeepId,
    reason: group.reason,
    members: group.members.map((m) => ({
      id: m.id,
      title: m.title,
      filename: m.filename,
      category: m.category,
      visibility: m.visibility,
      sizeBytes: m.sizeBytes,
      uploadedAt:
        m.uploadedAt instanceof Date
          ? m.uploadedAt.toISOString()
          : new Date((m.uploadedAt ?? 0) as number).toISOString(),
    })),
  };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const db = getDb(env);

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      filename: documents.filename,
      category: documents.category,
      visibility: documents.visibility,
      sizeBytes: documents.sizeBytes,
      contentType: documents.contentType,
      contentHash: documents.contentHash,
      r2Key: documents.r2Key,
      uploadedAt: documents.uploadedAt,
    })
    .from(documents);

  // Lazy-backfill missing hashes, bounded per call.
  let hashed = 0;
  let remaining = 0;
  for (const row of rows) {
    if (row.contentHash) continue;
    if (hashed >= BACKFILL_CAP) {
      remaining++;
      continue;
    }
    const obj = await env.DOCS.get(row.r2Key);
    if (!obj) continue;
    const hash = await sha256Hex(await obj.arrayBuffer());
    await db
      .update(documents)
      .set({ contentHash: hash })
      .where(eq(documents.id, row.id));
    row.contentHash = hash;
    hashed++;
  }

  const docs: DocLike[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    contentType: r.contentType,
    visibility: r.visibility,
    category: r.category,
    uploadedAt: r.uploadedAt ?? undefined,
    contentHash: r.contentHash,
  }));

  return Response.json({
    exact: groupExact(docs).map(serialize),
    near: groupNear(docs).map(serialize),
    remaining,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body =
    parsed.value && typeof parsed.value === 'object'
      ? (parsed.value as Record<string, unknown>)
      : {};
  if (body.action !== 'resolve')
    return new Response('Bad action', { status: 400 });
  const keepId = stringField(body, 'keepId');
  if (!keepId) return new Response('keepId is required', { status: 400 });
  const deleteIds = Array.isArray(body.deleteIds)
    ? body.deleteIds.filter((x): x is string => typeof x === 'string')
    : [];
  if (deleteIds.length === 0)
    return new Response('deleteIds is required', { status: 400 });
  if (deleteIds.includes(keepId))
    return new Response('keepId cannot be in deleteIds', { status: 400 });

  const db = getDb(env);
  for (const id of deleteIds) {
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    if (!doc) continue;
    await env.DOCS.delete(doc.r2Key);
    await db.delete(documents).where(eq(documents.id, id));
  }
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-duplicates.test.ts test/server/admin-duplicates-board.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/pages/api/admin/duplicates.ts test/server/admin-duplicates.test.ts test/server/admin-duplicates-board.test.ts
git commit -m "feat(dedupe): admin duplicates endpoint (lazy-backfill report + resolve)"
```

---

### Task 7: Duplicates admin panel + nav wiring

**Files:**

- Create: `src/components/admin/DuplicatesManager.tsx`
- Create: `src/components/admin/DuplicatesManager.test.tsx`
- Modify: `src/components/admin/AdminApp.tsx` (import + `SECTIONS`, lines 5-29)

**Interfaces:**

- Consumes: `fetchDuplicates`, `resolveDuplicates` from `../../lib/admin`; `useAdminResource`; `DuplicatesView` type.

- [ ] **Step 1: Write the failing test**

Create `src/components/admin/DuplicatesManager.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchDuplicates = vi.fn();
const resolveDuplicates = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchDuplicates: (...a: unknown[]) => fetchDuplicates(...a),
  resolveDuplicates: (...a: unknown[]) => resolveDuplicates(...a),
}));

import DuplicatesManager from './DuplicatesManager';

const member = (id: string, filename: string) => ({
  id,
  title: filename.replace(/\.[^.]+$/, ''),
  filename,
  category: 'Other',
  visibility: 'board',
  sizeBytes: 100,
  uploadedAt: '2026-01-01T00:00:00.000Z',
});

describe('DuplicatesManager', () => {
  beforeEach(() => {
    fetchDuplicates.mockReset();
    resolveDuplicates.mockClear();
    // jsdom's window.confirm returns false by default, which would block the
    // resolve path — force it true so the click actually calls resolveDuplicates.
    vi.stubGlobal('confirm', () => true);
  });

  it('shows a friendly empty state when there are no duplicates', async () => {
    fetchDuplicates.mockResolvedValue({ exact: [], near: [], remaining: 0 });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/no duplicates/i)).toBeInTheDocument();
  });

  it('resolves an exact group with one click keeping the suggested id', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [
        {
          suggestedKeepId: 'keep',
          members: [member('keep', 'a.pdf'), member('drop', 'a(1).pdf')],
        },
      ],
      near: [],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    const btn = await screen.findByRole('button', {
      name: /keep suggested/i,
    });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(resolveDuplicates).toHaveBeenCalledWith('keep', ['drop']),
    );
  });

  it('renders a near group as needing manual review', async () => {
    fetchDuplicates.mockResolvedValue({
      exact: [],
      near: [
        {
          suggestedKeepId: 'x',
          reason: 'similar filename/size',
          members: [member('x', 'Report.pdf'), member('y', 'Report copy.pdf')],
        },
      ],
      remaining: 0,
    });
    render(<DuplicatesManager />);
    expect(await screen.findByText(/Report\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/similar filename\/size/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/admin/DuplicatesManager.test.tsx`
Expected: FAIL — cannot resolve `./DuplicatesManager`.

- [ ] **Step 3: Write the panel**

Create `src/components/admin/DuplicatesManager.tsx`:

```tsx
import { useState } from 'react';
import { fetchDuplicates, resolveDuplicates } from '../../lib/admin';
import type { DupeGroupView, DuplicatesView } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const EMPTY: DuplicatesView = { exact: [], near: [], remaining: 0 };

function GroupCard({
  group,
  kind,
  onResolve,
  busy,
}: {
  group: DupeGroupView;
  kind: 'exact' | 'near';
  onResolve: (keepId: string, deleteIds: string[]) => void;
  busy: boolean;
}) {
  const [keepId, setKeepId] = useState(group.suggestedKeepId);
  const deleteIds = group.members
    .filter((m) => m.id !== keepId)
    .map((m) => m.id);
  return (
    <div className="panel-card" style={{ marginBottom: '16px' }}>
      <div className="panel-editor__title">
        {kind === 'exact' ? 'Identical files' : 'Possibly the same document'}
        {group.reason ? ` — ${group.reason}` : ''}
      </div>
      <div className="panel-list">
        {group.members.map((m) => (
          <label key={m.id} className="list-row" style={{ cursor: 'pointer' }}>
            <input
              type="radio"
              name={`keep-${group.members[0].id}`}
              checked={keepId === m.id}
              onChange={() => setKeepId(m.id)}
              style={{ marginRight: '10px' }}
            />
            <div className="admin-row-main">
              <div className="admin-row-title">{m.title}</div>
              <div className="admin-row-sub">
                {m.filename} &middot; {m.category} &middot; {m.visibility}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: '10px' }}>
        <button
          className="btn btn--small"
          disabled={busy || deleteIds.length === 0}
          onClick={() => onResolve(keepId, deleteIds)}
        >
          {kind === 'exact'
            ? 'Keep suggested, delete the rest'
            : 'Keep selected, delete the others'}
        </button>
      </div>
    </div>
  );
}

export default function DuplicatesManager() {
  const { data, loading, reload, busy, msg, run } =
    useAdminResource<DuplicatesView>(fetchDuplicates, EMPTY);

  async function handleResolve(keepId: string, deleteIds: string[]) {
    if (
      !confirm(
        `Delete ${deleteIds.length} duplicate file(s)? This cannot be undone.`,
      )
    )
      return;
    await run(async () => {
      await resolveDuplicates(keepId, deleteIds);
      await reload();
    }, 'Duplicates resolved.');
  }

  const total = data.exact.length + data.near.length;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Duplicates</h1>
      </div>
      <p className="admin-panel__intro">
        Identical files can be collapsed with one click. “Possibly the same”
        groups are a heuristic — review each before deleting.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}
      {data.remaining > 0 && (
        <div className="form-message" role="status">
          Still scanning… {data.remaining} file(s) not yet hashed.{' '}
          <button className="row-link" onClick={() => reload()}>
            Continue scanning
          </button>
        </div>
      )}

      {loading ? (
        <p className="loading panel-pad">Scanning documents…</p>
      ) : total === 0 ? (
        <p className="muted panel-pad">No duplicates found. 🎉</p>
      ) : (
        <>
          {data.exact.map((g) => (
            <GroupCard
              key={g.members[0].id}
              group={g}
              kind="exact"
              busy={busy}
              onResolve={handleResolve}
            />
          ))}
          {data.near.map((g) => (
            <GroupCard
              key={g.members[0].id}
              group={g}
              kind="near"
              busy={busy}
              onResolve={handleResolve}
            />
          ))}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the nav in `AdminApp.tsx`**

Add the import after line 6 (`import DocumentsManager …`):

```ts
import DuplicatesManager from './DuplicatesManager';
```

Add a section entry to `SECTIONS` right after the `documents` entry (line 19):

```ts
  { key: 'documents', label: 'Documents', render: () => <DocumentsManager /> },
  {
    key: 'duplicates',
    label: 'Duplicates',
    render: () => <DuplicatesManager />,
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/admin/DuplicatesManager.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/components/admin/DuplicatesManager.tsx src/components/admin/DuplicatesManager.test.tsx src/components/admin/AdminApp.tsx
git commit -m "feat(dedupe): admin Duplicates panel + nav section"
```

---

### Task 8: Bulk cleanup script — `npm run docs:dedupe`

**Files:**

- Create: `scripts/dedupe-documents.ts`
- Modify: `package.json` (scripts, after `docs:import` on line 27)
- Test: `test/unit/dedupe-documents.test.ts`

**Interfaces:**

- Consumes: `sha256Hex`, `groupExact`, `groupNear`, `autoResolvableExact`, `DocLike`, `DupeGroup` from the engine; `DocumentEntry` type from `scripts/import-documents.ts`.
- Produces (pure, unit-tested exports):
  - `buildHashUpdateSql(rows: { id: string; contentHash: string }[]): string`
  - `planExactDeletions(groups: DupeGroup[]): { keepId: string; deleteIds: string[] }[]`

- [ ] **Step 1: Write the failing test**

Create `test/unit/dedupe-documents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildHashUpdateSql,
  planExactDeletions,
} from '../../scripts/dedupe-documents';
import type { DocLike } from '../../src/server/content/dedupe';

const doc = (over: Partial<DocLike>): DocLike => ({
  id: 'id',
  title: 't',
  filename: 'f.pdf',
  sizeBytes: 1,
  contentType: 'application/pdf',
  visibility: 'board',
  ...over,
});

describe('buildHashUpdateSql', () => {
  it('emits an UPDATE per row and escapes single quotes in ids', () => {
    const sql = buildHashUpdateSql([
      { id: 'a', contentHash: 'h1' },
      { id: "o'brien", contentHash: 'h2' },
    ]);
    expect(sql).toContain(
      "UPDATE documents SET content_hash = 'h1' WHERE id = 'a';",
    );
    expect(sql).toContain("id = 'o''brien'");
  });
});

describe('planExactDeletions', () => {
  it('plans deletions only for same-tier exact groups', () => {
    const sameTier = {
      members: [
        doc({ id: 'keep', filename: 'a.pdf', visibility: 'board' }),
        doc({ id: 'drop', filename: 'a(1).pdf', visibility: 'board' }),
      ],
      suggestedKeepId: 'keep',
    };
    const crossTier = {
      members: [
        doc({ id: 'p', visibility: 'public' }),
        doc({ id: 'b', visibility: 'board' }),
      ],
      suggestedKeepId: 'p',
    };
    expect(planExactDeletions([sameTier, crossTier])).toEqual([
      { keepId: 'keep', deleteIds: ['drop'] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/dedupe-documents.test.ts`
Expected: FAIL — cannot resolve `../../scripts/dedupe-documents`.

- [ ] **Step 3: Write the script**

Create `scripts/dedupe-documents.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  sha256Hex,
  groupExact,
  groupNear,
  autoResolvableExact,
  type DocLike,
  type DupeGroup,
} from '../src/server/content/dedupe.ts';
import type { DocumentEntry } from './import-documents.ts';

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** One `UPDATE … SET content_hash` per row. Pure; unit-tested. */
export function buildHashUpdateSql(
  rows: { id: string; contentHash: string }[],
): string {
  return (
    rows
      .map(
        (r) =>
          `UPDATE documents SET content_hash = ${sqlStr(r.contentHash)} WHERE id = ${sqlStr(r.id)};`,
      )
      .join('\n') + '\n'
  );
}

/** Same-tier exact groups only (safety rule). Pure; unit-tested. */
export function planExactDeletions(
  groups: DupeGroup[],
): { keepId: string; deleteIds: string[] }[] {
  return groups
    .map(autoResolvableExact)
    .filter(
      (x): x is { keepId: string; deleteIds: string[] } =>
        x !== null && x.deleteIds.length > 0,
    );
}

async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const commit = process.argv.includes('--commit');
  const sourceDir = 'private/HOA_files';
  const manifestPath = 'private/documents-manifest.json';

  if (!fs.existsSync(manifestPath)) {
    console.error(
      `Error: ${manifestPath} not found. Run \`npm run docs:import\` first.`,
    );
    process.exit(1);
  }
  const entries = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as DocumentEntry[];

  const docs: DocLike[] = [];
  const hashRows: { id: string; contentHash: string }[] = [];
  for (const e of entries) {
    const full = path.join(sourceDir, e.relativePath);
    if (!fs.existsSync(full)) {
      console.warn(`Skipping (missing on disk): ${e.relativePath}`);
      continue;
    }
    const contentHash = await sha256Hex(fs.readFileSync(full));
    hashRows.push({ id: e.id, contentHash });
    docs.push({
      id: e.id,
      title: e.title,
      filename: e.filename,
      sizeBytes: e.sizeBytes,
      contentType: e.contentType,
      visibility: e.visibility as DocLike['visibility'],
      category: e.category,
      contentHash,
    });
  }

  const exact = groupExact(docs);
  const near = groupNear(docs);
  const deletions = planExactDeletions(exact);
  const deletedIds = new Set(deletions.flatMap((d) => d.deleteIds));

  const reportPath = 'private/dedupe-report.json';
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        exactGroups: exact.length,
        nearGroups: near.length,
        autoDeletable: [...deletedIds],
        crossTierExact: exact
          .filter((g) => autoResolvableExact(g) === null)
          .map((g) => g.members.map((m) => m.filename)),
        exact,
        near,
      },
      null,
      2,
    ),
  );

  console.log(
    `Hashed ${docs.length} files. Exact groups: ${exact.length}, near groups: ${near.length}. ` +
      `${deletedIds.size} files auto-deletable (same-tier exact). Report: ${reportPath}.`,
  );

  if (!commit) {
    console.log(
      `\nReview ${reportPath}, then re-run with \`-- --commit\` to write hashes and delete same-tier exact duplicates.`,
    );
    return;
  }

  // --- commit: write hashes, then delete same-tier exact extras ---
  const nodeRequire = createRequire(import.meta.url);
  const wranglerBin = path.join(
    path.dirname(nodeRequire.resolve('wrangler/package.json')),
    'bin',
    'wrangler.js',
  );
  const runWrangler = (args: string[]) =>
    execFileSync(process.execPath, [wranglerBin, ...args], {
      stdio: 'inherit',
    });

  const hashSqlPath = 'private/dedupe-hashes.sql';
  fs.writeFileSync(hashSqlPath, buildHashUpdateSql(hashRows));
  console.log('Writing content hashes to D1...');
  runWrangler([
    'd1',
    'execute',
    'ashebrook-hoa',
    '--remote',
    '--file',
    hashSqlPath,
  ]);

  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const id of deletedIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    console.log(`Deleting R2 object for ${entry.filename} (${id})`);
    runWrangler([
      'r2',
      'object',
      'delete',
      `ashebrook-hoa-docs/${entry.r2Key}`,
      '--remote',
    ]);
  }

  if (deletedIds.size > 0) {
    const ids = [...deletedIds].map((id) => sqlStr(id)).join(', ');
    const delSqlPath = 'private/dedupe-delete.sql';
    fs.writeFileSync(
      delSqlPath,
      `DELETE FROM documents WHERE id IN (${ids});\n`,
    );
    console.log('Deleting duplicate rows from D1...');
    runWrangler([
      'd1',
      'execute',
      'ashebrook-hoa',
      '--remote',
      '--file',
      delSqlPath,
    ]);
  }

  console.log(
    `\nDone. Wrote ${hashRows.length} hashes; deleted ${deletedIds.size} same-tier exact duplicates. ` +
      `Cross-tier exact groups and near-duplicates remain for review in the admin Duplicates panel.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add after the `docs:import` line (line 27):

```json
    "docs:import": "node --experimental-strip-types scripts/import-documents.ts",
    "docs:dedupe": "node --experimental-strip-types scripts/dedupe-documents.ts"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/dedupe-documents.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the script runs in dry-run mode**

Run: `npm run docs:dedupe`
Expected: prints a hash/group summary and writes `private/dedupe-report.json` (no D1/R2 writes). If `private/documents-manifest.json` is absent in this environment, the script exits with the "run docs:import first" message — that is acceptable; note it and continue.

- [ ] **Step 7: Commit**

```bash
npm run format
git add scripts/dedupe-documents.ts package.json test/unit/dedupe-documents.test.ts
git commit -m "feat(dedupe): docs:dedupe bulk cleanup script (dry-run + --commit)"
```

---

### Task 9: Full verification + docs sync

**Files:**

- Modify: `CLAUDE.md`, `SETUP.md`, `README.md`, `CHANGELOG.md` (via docs-updater)
- Confirm: `.gitignore` covers the script's outputs

- [ ] **Step 1: Ensure generated artifacts are ignored**

Confirm `private/dedupe-report.json`, `private/dedupe-hashes.sql`, and `private/dedupe-delete.sql` are not committed. Check `.gitignore` for a `private/` rule; if `private/` is not already ignored, add:

```
private/dedupe-report.json
private/dedupe-hashes.sql
private/dedupe-delete.sql
```

Run: `git status --porcelain` and confirm none of those three files appear as untracked-to-commit.

- [ ] **Step 2: Run the full local CI gate**

Run:

```bash
npm run format:check
npm run check
npm test
npm run test:server
npm run build
```

Expected: all PASS. Fix any failures before proceeding.

- [ ] **Step 3: Sync documentation**

Invoke the `docs-updater` subagent to update, at minimum:

- `CLAUDE.md` — the new `content_hash` column (data model), the `duplicates` endpoint under HTTP endpoints, the `docs:dedupe` command, and the near/exact upload-guard behavior.
- `SETUP.md` — a short "Deduplicating documents" subsection: run `npm run docs:dedupe`, review `private/dedupe-report.json`, then `-- --commit`; and note the admin Duplicates panel for ongoing use.
- `CHANGELOG.md` — a feature entry.

- [ ] **Step 4: Commit the docs**

```bash
npm run format
git add CLAUDE.md SETUP.md README.md CHANGELOG.md .gitignore
git commit -m "docs(dedupe): document dedup column, endpoint, script, and panel"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/document-dedupe
gh pr create --fill --base main
```

---

## Self-Review

**Spec coverage:**

- §4 data model (`content_hash` nullable, non-unique, indexed) → Task 1. ✓
- §5 shared engine (all functions) → Task 2. ✓
- §6 upload guard (block exact / warn near / persist hash) → Task 3 (server) + Tasks 4–5 (client/UI). ✓
- §7 panel endpoints (lazy backfill, groups, resolve) → Task 6; panel UI → Task 7. ✓
- §8 bulk script (local-source hashing, dry-run/`--commit`, report) → Task 8. ✓
- §9 safety rules (same-tier auto-collapse, keep tie-break, near never auto-acted) → `autoResolvableExact`/`suggestedKeepId` in Task 2; enforced in Tasks 6/8. ✓
- §10 testing (unit + server across engine, guard, endpoints, UI) → Tasks 2–8. ✓
- §11 rollout (migrate, ship guard+panel, run script, docs) → Tasks 1, 3–8, 9. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code. The migration filename is generated by `db:generate` (its content is pinned in Task 1 Step 4). The `NEAR_THRESHOLD`/tolerance values are concrete (0.6 / 0.05 / +0.2 boost); tests assert behavior, not the constants, so tuning stays safe.

**Type consistency:** `DocLike`, `DupeGroup`, `suggestedKeepId`, `groupExact`, `groupNear`, `autoResolvableExact`, `nearScore`, `NEAR_THRESHOLD`, `sha256Hex` are defined in Task 2 and used with the same signatures in Tasks 3, 6, 8. Client `DuplicateError`/`uploadDocument(…, confirmDuplicate)` defined in Task 4, consumed in Task 5. `DupeMember`/`DupeGroupView`/`DuplicatesView` defined in Task 4 (`types.ts`), consumed in Tasks 4/7. HTTP contract (`{ error:'exact-duplicate', existing }` / `{ warning:'near-duplicate', similar }` / `{ exact, near, remaining }` / `{ action:'resolve', keepId, deleteIds }`) is identical across producer (Tasks 3/6) and consumer (Tasks 4/5/7).
