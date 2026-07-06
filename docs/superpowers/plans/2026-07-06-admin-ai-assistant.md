# Admin AI Document Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a board-only chat assistant in `/admin` that answers questions grounded in the document library, streaming the answer with source citations, and pseudonymizing known resident PII so it is not sent to Anthropic.

**Architecture:** Cloudflare AI Search (managed RAG over the existing `ashebrook-hoa-docs` R2 bucket) retrieves passages against real text inside Cloudflare; a reversible pseudonymizer (built from the D1 roster + regex) swaps resident PII for realistic surrogates before the passages reach Claude Opus 4.8; Claude's streamed answer is de-anonymized on the way back to the board. A board-only SSE endpoint orchestrates it; a React island renders the chat.

**Tech Stack:** Astro SSR on Cloudflare Workers, D1 + Drizzle, R2, Better Auth, React 19, Vitest (jsdom + `@cloudflare/vitest-pool-workers`), `@anthropic-ai/sdk`, Cloudflare AI Search (`env.AI.autorag`).

## Global Constraints

- **Board-only, fail-closed.** Every request to `/api/admin/assistant` goes through `requireBoard(locals, request, env)` first, exactly like the other `/api/admin/*` routes (`requireBoard` returns a `Response` to short-circuit or `null`).
- **`env` comes from `import { env } from 'cloudflare:workers'`** in endpoints/server modules; build-time `PUBLIC_*` vars are inlined from `.env`.
- **Model ID is exactly `claude-opus-4-8`.** Adaptive thinking only: `thinking: { type: 'adaptive' }` (never `budget_tokens`; never `temperature`/`top_p`/`top_k` — they 400). Stream (`client.messages.stream(...)`).
- **No real resident PII may reach Anthropic.** The privacy property depends on inbound `anonymize()` completeness; a server test asserts the Anthropic payload contains none of the seeded roster's real values.
- **New server code lives under `src/server/ai/`.** Endpoint at `src/pages/api/admin/assistant.ts` with `export const prerender = false`.
- **Full gate before every push:** `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.
- **Commit message trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Dependency floor caveat:** `@cloudflare/workers-types` stays at v4 (Dependabot #26 is blocked upstream); do not rely on a v5-only `Ai.autorag` type — this plan declares its own minimal AI Search binding type.

---

## File Structure

**Created:**
- `src/server/ai/search.ts` — AI Search retrieval wrapper + the minimal AI Search binding types.
- `src/server/ai/pii.ts` — reversible pseudonymizer (surrogate pools, `buildPseudonymizer`, `anonymize`, `deanonymize`, `deanonymizeStream`).
- `src/server/ai/sources.ts` — map retrieved chunks → real D1 document rows + download links.
- `src/server/ai/anthropic.ts` — Anthropic client factory + `AssistantNotConfiguredError`.
- `src/server/ai/assistant.ts` — orchestration: roster load → retrieve → anonymize → Claude stream → de-anonymize.
- `src/pages/api/admin/assistant.ts` — board-only SSE endpoint.
- `src/components/admin/AssistantChat.tsx` — chat island.
- `test/unit/pii.test.ts`, `test/unit/ai-search.test.ts`, `src/components/admin/AssistantChat.test.tsx`
- `test/server/ai-sources.test.ts`, `test/server/admin-assistant.test.ts`

**Modified:**
- `package.json` — add `@anthropic-ai/sdk`.
- `wrangler.toml` — add `[ai]` binding + `AI_SEARCH_INSTANCE` var.
- `src/env.d.ts` — add `AI`, `AI_SEARCH_INSTANCE`, `ANTHROPIC_API_KEY`.
- `src/lib/types.ts` — add `INPUT_LIMITS.assistantQuestion`.
- `src/components/admin/AdminApp.tsx` — add the `Assistant` section.
- `CLAUDE.md`, `SETUP.md`, `SECURITY.md`, `CHANGELOG.md`.

---

## Task 1: Config, dependency, and binding types

**Files:**
- Modify: `package.json`
- Modify: `wrangler.toml`
- Create: `src/server/ai/search.ts` (types only in this task; retrieval logic added in Task 4)
- Modify: `src/env.d.ts`
- Modify: `src/lib/types.ts:196-207` (the `INPUT_LIMITS` object)

**Interfaces:**
- Produces: the `AiBinding`, `AiSearchResult`, `AiSearchChunk` types (from `search.ts`); `env.AI`, `env.AI_SEARCH_INSTANCE`, `env.ANTHROPIC_API_KEY`; `INPUT_LIMITS.assistantQuestion`.

- [ ] **Step 1: Install the Anthropic SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: `package.json` `dependencies` gains `@anthropic-ai/sdk`; `package-lock.json` updated.

- [ ] **Step 2: Add the AI Search binding + instance name to `wrangler.toml`**

Append to `wrangler.toml`:

```toml
# Workers AI binding — used for the admin document assistant's retrieval via
# Cloudflare AI Search (env.AI.autorag(...)). The AI Search instance is created
# once in the dashboard against the ashebrook-hoa-docs R2 bucket (see SETUP.md).
[ai]
binding = "AI"

[vars]
# ...existing BETTER_AUTH_URL stays; add the AI Search instance name:
AI_SEARCH_INSTANCE = "ashebrook-docs"
```

Note: `[vars]` already exists in `wrangler.toml` with `BETTER_AUTH_URL` — add `AI_SEARCH_INSTANCE` to that existing block rather than creating a second `[vars]` table.

- [ ] **Step 3: Create `src/server/ai/search.ts` with the binding types**

```ts
// Minimal typings for the Cloudflare AI Search (autorag) binding — declared here
// rather than relying on @cloudflare/workers-types (pinned at v4; autorag typing
// is not guaranteed). Only the `search()` surface we use is modeled.
export interface AiSearchChunk {
  id: string;
  score: number;
  content: string;
  metadata: { filename: string; folder: string; timestamp: number };
}

export interface AiSearchResult {
  search_query: string;
  data: AiSearchChunk[];
  has_more: boolean;
}

export interface AutoRag {
  search(opts: {
    query: string;
    max_num_results?: number;
    ranking_options?: { score_threshold?: number };
    rewrite_query?: boolean;
  }): Promise<AiSearchResult>;
}

export interface AiBinding {
  autorag(instance: string): AutoRag;
}
```

- [ ] **Step 4: Extend `Cloudflare.Env` in `src/env.d.ts`**

Add these members inside the `interface Env` block (after `TURNSTILE_SECRET_KEY`):

```ts
    /** Anthropic API key for the admin document assistant (Claude generation). */
    ANTHROPIC_API_KEY: string;
    /** Cloudflare AI Search (autorag) binding for document retrieval. */
    AI: import('./server/ai/search').AiBinding;
    /** Name of the AI Search instance created in the dashboard. */
    AI_SEARCH_INSTANCE: string;
```

- [ ] **Step 5: Add the assistant question length cap in `src/lib/types.ts`**

In the `INPUT_LIMITS` object (currently `src/lib/types.ts:196-207`), add:

```ts
  assistantQuestion: 2_000,
```

- [ ] **Step 6: Verify types and build**

Run: `npm run check`
Expected: PASS (no type errors from the new bindings/types).

Run: `npm run build`
Expected: PASS — the Astro Cloudflare adapter emits `dist/server/wrangler.json`. Grep it to confirm the AI binding surfaced: `grep -o '"AI"' dist/server/wrangler.json` should print `"AI"`. If it does not, the adapter did not carry the `[ai]` binding through — record it as a follow-up and add the binding to the adapter config, but do not block the rest of the plan (bindings can be added in the dashboard).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json wrangler.toml src/server/ai/search.ts src/env.d.ts src/lib/types.ts
git commit -m "chore(assistant): add AI binding, Anthropic SDK, and assistant config" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: PII pseudonymizer core — `anonymize` / `deanonymize`

**Files:**
- Create: `src/server/ai/pii.ts`
- Test: `test/unit/pii.test.ts`

**Interfaces:**
- Produces:
  - `type PiiType = 'name' | 'address' | 'phone' | 'email'`
  - `interface PiiEntry { type: PiiType; value: string }`
  - `interface Pseudonymizer { anonymize(text: string): string; deanonymize(text: string): string; deanonymizeStream(): TransformStream<string, string> }` (`deanonymizeStream` implemented in Task 3)
  - `function buildPseudonymizer(entries: PiiEntry[]): Pseudonymizer`

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/pii.test.ts
import { describe, it, expect } from 'vitest';
import { buildPseudonymizer, type PiiEntry } from '../../src/server/ai/pii';

const ROSTER: PiiEntry[] = [
  { type: 'name', value: 'Jane Q Homeowner' },
  { type: 'name', value: 'Bob Neighbor' },
  { type: 'address', value: '123 Ashebrook Lane' },
  { type: 'phone', value: '(919) 555-0100' },
  { type: 'email', value: 'jane@realmail.com' },
];

describe('pseudonymizer — anonymize', () => {
  it('replaces every roster name/address/phone/email in the text', () => {
    const p = buildPseudonymizer(ROSTER);
    const text =
      'Jane Q Homeowner at 123 Ashebrook Lane, call (919) 555-0100 or jane@realmail.com. Bob Neighbor too.';
    const out = p.anonymize(text);
    for (const e of ROSTER) expect(out).not.toContain(e.value);
    // A phone/email that is NOT in the roster still gets scrubbed by regex.
    const out2 = p.anonymize('Reach vendor at vendor@acme.co or 704-555-0199.');
    expect(out2).not.toContain('vendor@acme.co');
    expect(out2).not.toContain('704-555-0199');
  });

  it('is consistent — the same real value maps to the same surrogate', () => {
    const p = buildPseudonymizer(ROSTER);
    const a = p.anonymize('Jane Q Homeowner');
    const b = p.anonymize('Contact Jane Q Homeowner today.');
    expect(b).toContain(a.trim());
  });

  it('round-trips: deanonymize(anonymize(text)) restores the original', () => {
    const p = buildPseudonymizer(ROSTER);
    const text = 'Jane Q Homeowner lives at 123 Ashebrook Lane.';
    expect(p.deanonymize(p.anonymize(text))).toBe(text);
  });

  it('does not corrupt overlapping matches (single-pass, longest-first)', () => {
    // A name that is a substring of an address-like phrase must not double-replace.
    const p = buildPseudonymizer([
      { type: 'name', value: 'Ashebrook' },
      { type: 'address', value: '123 Ashebrook Lane' },
    ]);
    const out = p.anonymize('Mail to 123 Ashebrook Lane please.');
    expect(out).not.toContain('123 Ashebrook Lane');
    // The longer address match wins; the standalone "Ashebrook" surrogate is not
    // spliced inside the address replacement.
    expect(p.deanonymize(out)).toBe('Mail to 123 Ashebrook Lane please.');
  });

  it('never emits a surrogate equal to a real roster value', () => {
    const p = buildPseudonymizer(ROSTER);
    const out = p.anonymize('Jane Q Homeowner and Bob Neighbor');
    // Surrogates come from disjoint pools / reserved ranges; assert no real leaks.
    expect(out).not.toContain('Jane Q Homeowner');
    expect(out).not.toContain('Bob Neighbor');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/pii.test.ts`
Expected: FAIL — `buildPseudonymizer` is not defined / module not found.

- [ ] **Step 3: Implement `src/server/ai/pii.ts` (core, no streaming yet)**

```ts
// Reversible PII pseudonymization for the admin document assistant.
//
// Real resident PII (from the roster) and any email/phone anywhere are swapped
// for realistic, consistent, reversible surrogates BEFORE text reaches Anthropic,
// and mapped back on the way out. Privacy depends on `anonymize` completeness;
// `deanonymize` is best-effort/cosmetic (see the design spec §4.4).

export type PiiType = 'name' | 'address' | 'phone' | 'email';
export interface PiiEntry {
  type: PiiType;
  value: string;
}

export interface Pseudonymizer {
  anonymize(text: string): string;
  deanonymize(text: string): string;
  deanonymizeStream(): TransformStream<string, string>;
}

// --- Surrogate pools (deterministic, collision-free by construction) ---
const FIRST = [
  'Avery', 'Blake', 'Casey', 'Devon', 'Emerson', 'Finley', 'Harper', 'Jordan',
  'Kendall', 'Logan', 'Morgan', 'Parker', 'Quinn', 'Reese', 'Sawyer', 'Taylor',
];
const LAST = [
  'Ashfield', 'Brookmere', 'Calder', 'Dunmore', 'Ellery', 'Fenwick', 'Granger',
  'Holloway', 'Ives', 'Larkin', 'Merrow', 'Presley', 'Rowan', 'Sutton',
];
const STREETS = [
  'Maple', 'Cedar', 'Birch', 'Willow', 'Juniper', 'Aspen', 'Sycamore', 'Poplar',
  'Hawthorn', 'Linden', 'Chestnut', 'Magnolia',
];
const SUFFIX = ['Street', 'Avenue', 'Court', 'Drive', 'Lane', 'Way'];
const EMAIL_DOMAIN = 'example.org'; // reserved; never a real address

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// NANP-style: optional +1, area code (parens optional), separators optional.
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g;

function normName(v: string): string {
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}
function normPhone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeName(i: number): string {
  return `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
}
function makeAddress(i: number): string {
  const num = 100 + ((i * 37) % 800);
  return `${num} ${STREETS[i % STREETS.length]} ${SUFFIX[Math.floor(i / STREETS.length) % SUFFIX.length]}`;
}
function makePhone(i: number): string {
  // 555-01xx line-number range is reserved for fictional use.
  const line = String(1000 + (i * 7) % 9000).padStart(4, '0');
  const prefix = String(100 + (i % 100)).padStart(3, '0');
  return `(555) ${prefix}-${line}`;
}
function makeEmail(i: number): string {
  const f = FIRST[i % FIRST.length].toLowerCase();
  const l = LAST[Math.floor(i / FIRST.length) % LAST.length].toLowerCase();
  return `${f}.${l}${i}@${EMAIL_DOMAIN}`;
}

interface Span {
  start: number;
  end: number;
  replacement: string;
  len: number;
}

function applySpans(text: string, spans: Span[]): string {
  // Non-overlapping, longest-first: sort by start asc then length desc, then
  // greedily keep spans that don't overlap a chosen one; splice right-to-left.
  spans.sort((a, b) => a.start - b.start || b.len - a.len);
  const chosen: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      chosen.push(s);
      lastEnd = s.end;
    }
  }
  let out = text;
  for (let i = chosen.length - 1; i >= 0; i--) {
    const s = chosen[i];
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  }
  return out;
}

export function buildPseudonymizer(entries: PiiEntry[]): Pseudonymizer {
  const forward = new Map<string, string>(); // `${type}:${norm}` -> surrogate
  const reverse = new Map<string, string>(); // surrogate -> real
  const realValues = new Set<string>(); // exact real strings, to avoid collisions
  const counts: Record<PiiType, number> = { name: 0, address: 0, phone: 0, email: 0 };
  // Dictionary of known literal strings to match (names + addresses), longest first.
  const dict: { type: PiiType; value: string }[] = [];
  let maxSurrogateLen = 1;

  function keyOf(type: PiiType, value: string): string {
    const n =
      type === 'phone' ? normPhone(value)
      : type === 'email' ? value.toLowerCase()
      : normName(value);
    return `${type}:${n}`;
  }

  function gen(type: PiiType): string {
    // Bump the index until the surrogate collides with neither a real value nor
    // an already-issued surrogate.
    for (;;) {
      const i = counts[type]++;
      const s =
        type === 'name' ? makeName(i)
        : type === 'address' ? makeAddress(i)
        : type === 'phone' ? makePhone(i)
        : makeEmail(i);
      if (!realValues.has(s) && !reverse.has(s)) return s;
    }
  }

  function surrogateFor(type: PiiType, real: string): string {
    const k = keyOf(type, real);
    let s = forward.get(k);
    if (!s) {
      s = gen(type);
      forward.set(k, s);
      reverse.set(s, real);
      if (s.length > maxSurrogateLen) maxSurrogateLen = s.length;
    }
    return s;
  }

  // Pre-register roster entries so surrogates are stable and dictionary-driven.
  for (const e of entries) realValues.add(e.value);
  for (const e of entries) {
    surrogateFor(e.type, e.value);
    if (e.type === 'name' || e.type === 'address') dict.push({ type: e.type, value: e.value });
  }
  // Longest literals first so an address wins over a name substring.
  dict.sort((a, b) => b.value.length - a.value.length);

  function anonymize(text: string): string {
    const spans: Span[] = [];
    for (const m of text.matchAll(EMAIL_RE)) {
      const real = m[0];
      spans.push({ start: m.index!, end: m.index! + real.length, len: real.length, replacement: surrogateFor('email', real) });
    }
    for (const m of text.matchAll(PHONE_RE)) {
      const real = m[0];
      if (normPhone(real).length !== 10) continue;
      spans.push({ start: m.index!, end: m.index! + real.length, len: real.length, replacement: surrogateFor('phone', real) });
    }
    for (const { type, value } of dict) {
      const re = new RegExp(escapeRegExp(value), 'gi');
      for (const m of text.matchAll(re)) {
        spans.push({ start: m.index!, end: m.index! + value.length, len: value.length, replacement: surrogateFor(type, value) });
      }
    }
    return applySpans(text, spans);
  }

  const reverseByLen = () => [...reverse.keys()].sort((a, b) => b.length - a.length);

  function deanonymize(text: string): string {
    const spans: Span[] = [];
    for (const sur of reverseByLen()) {
      const real = reverse.get(sur)!;
      let idx = 0;
      while ((idx = text.indexOf(sur, idx)) !== -1) {
        spans.push({ start: idx, end: idx + sur.length, len: sur.length, replacement: real });
        idx += sur.length;
      }
    }
    return applySpans(text, spans);
  }

  function deanonymizeStream(): TransformStream<string, string> {
    // Implemented in Task 3.
    throw new Error('deanonymizeStream not implemented');
  }

  return { anonymize, deanonymize, deanonymizeStream };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/pii.test.ts`
Expected: PASS (all cases except any depending on `deanonymizeStream`, which no test here uses).

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/pii.ts test/unit/pii.test.ts
git commit -m "feat(assistant): reversible PII pseudonymizer (anonymize/deanonymize)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Streaming de-anonymization — `deanonymizeStream`

**Files:**
- Modify: `src/server/ai/pii.ts` (replace the `deanonymizeStream` stub)
- Test: `test/unit/pii.test.ts` (add a case)

**Interfaces:**
- Produces: a working `deanonymizeStream(): TransformStream<string, string>` that reassembles surrogates split across chunk boundaries.

- [ ] **Step 1: Write the failing test (append to `test/unit/pii.test.ts`)**

```ts
describe('pseudonymizer — deanonymizeStream', () => {
  it('reassembles a surrogate split across two chunks', async () => {
    const p = buildPseudonymizer([{ type: 'name', value: 'Jane Q Homeowner' }]);
    const sur = p.anonymize('Jane Q Homeowner').trim(); // e.g. "Avery Ashfield"
    const cut = Math.ceil(sur.length / 2);
    const parts = [`Owner is ${sur.slice(0, cut)}`, `${sur.slice(cut)} today.`];

    const out: string[] = [];
    const rs = new ReadableStream<string>({
      start(c) {
        for (const part of parts) c.enqueue(part);
        c.close();
      },
    });
    const reader = rs.pipeThrough(p.deanonymizeStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out.join('')).toBe('Owner is Jane Q Homeowner today.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/pii.test.ts -t "reassembles a surrogate"`
Expected: FAIL — throws "deanonymizeStream not implemented".

- [ ] **Step 3: Implement `deanonymizeStream` (replace the stub in `pii.ts`)**

Replace the stub `deanonymizeStream` with:

```ts
  function safeCutBefore(buffer: string, cut: number): number {
    // If a surrogate occurrence straddles `cut`, back up to its start so we never
    // emit a half surrogate. Surrogates are bounded by maxSurrogateLen.
    let best = cut;
    for (const sur of reverseByLen()) {
      let idx = 0;
      while ((idx = buffer.indexOf(sur, idx)) !== -1) {
        const end = idx + sur.length;
        if (idx < cut && end > cut && idx < best) best = idx;
        idx = end;
      }
    }
    return best;
  }

  function deanonymizeStream(): TransformStream<string, string> {
    let buffer = '';
    const hold = maxSurrogateLen;
    return new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk;
        if (buffer.length <= hold) return;
        let cut = safeCutBefore(buffer, buffer.length - hold);
        if (cut > 0) {
          controller.enqueue(deanonymize(buffer.slice(0, cut)));
          buffer = buffer.slice(cut);
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(deanonymize(buffer));
      },
    });
  }
```

- [ ] **Step 4: Run the full pii suite to verify it passes**

Run: `npx vitest run test/unit/pii.test.ts`
Expected: PASS (all cases, including the split-surrogate stream).

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/pii.ts test/unit/pii.test.ts
git commit -m "feat(assistant): streaming de-anonymization with cross-chunk hold-back" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AI Search retrieval wrapper — `retrieve`

**Files:**
- Modify: `src/server/ai/search.ts` (add the function under the existing types)
- Test: `test/unit/ai-search.test.ts`

**Interfaces:**
- Consumes: `env.AI` (`AiBinding`), `env.AI_SEARCH_INSTANCE`.
- Produces: `class AiSearchUnavailableError extends Error`; `function retrieve(env: Env, query: string, limit?: number): Promise<AiSearchChunk[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/ai-search.test.ts
import { describe, it, expect, vi } from 'vitest';
import { retrieve, AiSearchUnavailableError } from '../../src/server/ai/search';

function fakeEnv(search: (opts: unknown) => Promise<unknown>): Env {
  return {
    AI_SEARCH_INSTANCE: 'test-instance',
    AI: { autorag: () => ({ search }) },
  } as unknown as Env;
}

describe('retrieve', () => {
  it('passes the query to the configured instance and returns chunks', async () => {
    const search = vi.fn(async () => ({
      search_query: 'q',
      has_more: false,
      data: [
        { id: '1', score: 0.9, content: 'hello', metadata: { filename: 'a.pdf', folder: 'documents/uuid-1/', timestamp: 1 } },
      ],
    }));
    const chunks = await retrieve(fakeEnv(search), 'what is the late fee?');
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'what is the late fee?' }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('hello');
  });

  it('wraps binding errors as AiSearchUnavailableError', async () => {
    const search = vi.fn(async () => {
      throw new Error('AutoRAGNotFoundError');
    });
    await expect(retrieve(fakeEnv(search), 'x')).rejects.toBeInstanceOf(
      AiSearchUnavailableError,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/ai-search.test.ts`
Expected: FAIL — `retrieve` / `AiSearchUnavailableError` not exported.

- [ ] **Step 3: Add `retrieve` to `src/server/ai/search.ts`** (below the existing type declarations)

```ts
export class AiSearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Document search is temporarily unavailable');
    this.name = 'AiSearchUnavailableError';
    this.cause = cause;
  }
}

/** Retrieve the top document chunks relevant to `query` from the AI Search index. */
export async function retrieve(
  env: Env,
  query: string,
  limit = 8,
): Promise<AiSearchChunk[]> {
  try {
    const res = await env.AI.autorag(env.AI_SEARCH_INSTANCE).search({
      query,
      max_num_results: limit,
      ranking_options: { score_threshold: 0.3 },
      rewrite_query: true,
    });
    return res.data ?? [];
  } catch (err) {
    throw new AiSearchUnavailableError(err);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/ai-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/search.ts test/unit/ai-search.test.ts
git commit -m "feat(assistant): AI Search retrieval wrapper" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Chunk → document source mapping — `toSources`

**Files:**
- Create: `src/server/ai/sources.ts`
- Test: `test/server/ai-sources.test.ts`

**Interfaces:**
- Consumes: `AiSearchChunk` (Task 1), `getDb(env)`, `documents` schema.
- Produces:
  - `interface Source { id: string; title: string; category: string; href: string }`
  - `function toSources(env: Env, chunks: AiSearchChunk[]): Promise<Source[]>`

- [ ] **Step 1: Write the failing test**

```ts
// test/server/ai-sources.test.ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { toSources } from '../../src/server/ai/sources';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import type { AiSearchChunk } from '../../src/server/ai/search';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(documents).values({
    id: 'uuid-1',
    title: 'Collections Policy',
    category: 'Governing Documents',
    visibility: 'board',
    r2Key: 'documents/uuid-1/collections.pdf',
    filename: 'collections.pdf',
    sizeBytes: 10,
    contentType: 'application/pdf',
    uploadedAt: new Date(),
    updatedAt: new Date(),
  });
});

function chunk(folder: string): AiSearchChunk {
  return { id: 'c', score: 0.9, content: 'x', metadata: { filename: 'f.pdf', folder, timestamp: 1 } };
}

describe('toSources', () => {
  it('maps a documents/<uuid>/ folder to the real doc row + download link', async () => {
    const out = await toSources(env, [chunk('documents/uuid-1/collections.pdf')]);
    expect(out).toEqual([
      { id: 'uuid-1', title: 'Collections Policy', category: 'Governing Documents', href: '/api/files/uuid-1' },
    ]);
  });

  it('dedupes repeated chunks from the same document', async () => {
    const out = await toSources(env, [
      chunk('documents/uuid-1/collections.pdf'),
      chunk('documents/uuid-1/collections.pdf'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('ignores chunks whose uuid is not a known document', async () => {
    const out = await toSources(env, [chunk('documents/missing/x.pdf')]);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/ai-sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/ai/sources.ts`**

```ts
import { inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { documents } from '../db/schema';
import type { AiSearchChunk } from './search';

export interface Source {
  id: string;
  title: string;
  category: string;
  href: string;
}

/** The R2 layout is `documents/<uuid>/<filename>` — pull the uuid out. */
function docIdFromFolder(folder: string): string | null {
  const m = /(?:^|\/)documents\/([^/]+)\//.exec(folder);
  return m ? m[1] : null;
}

/**
 * Map retrieved chunks back to their real D1 document rows, in first-seen
 * (best-score) order, deduped by document id. Sources are board-only metadata
 * shown to the caller — they are NOT sent to Anthropic.
 */
export async function toSources(env: Env, chunks: AiSearchChunk[]): Promise<Source[]> {
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const id = docIdFromFolder(c.metadata.folder);
    if (id && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }
  if (orderedIds.length === 0) return [];

  const rows = await getDb(env)
    .select({ id: documents.id, title: documents.title, category: documents.category })
    .from(documents)
    .where(inArray(documents.id, orderedIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  return orderedIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ id: r.id, title: r.title, category: r.category, href: `/api/files/${r.id}` }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/ai-sources.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/sources.ts test/server/ai-sources.test.ts
git commit -m "feat(assistant): map retrieved chunks to real document sources" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Anthropic client + assistant orchestration — `answer`

**Files:**
- Create: `src/server/ai/anthropic.ts`
- Create: `src/server/ai/assistant.ts`
- Test: `test/server/admin-assistant.test.ts` (orchestration cases; endpoint cases added in Task 7)

**Interfaces:**
- Consumes: `retrieve` (Task 4), `toSources` + `Source` (Task 5), `buildPseudonymizer` + `PiiEntry` (Tasks 2–3), `getDb`, `owners`/`properties` schema.
- Produces:
  - `class AssistantNotConfiguredError extends Error` + `function getAnthropic(env: Env): Anthropic` (`anthropic.ts`)
  - `interface Turn { role: 'user' | 'assistant'; content: string }`
  - `interface AnswerResult { sources: Source[]; textStream: ReadableStream<string> }`
  - `function answer(env: Env, input: { question: string; history?: Turn[] }): Promise<AnswerResult>`
  - `function loadRosterEntries(env: Env): Promise<PiiEntry[]>` (exported for testing)

- [ ] **Step 1: Create `src/server/ai/anthropic.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';

export class AssistantNotConfiguredError extends Error {
  constructor() {
    super('The assistant is not configured');
    this.name = 'AssistantNotConfiguredError';
  }
}

export function getAnthropic(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new AssistantNotConfiguredError();
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/server/admin-assistant.test.ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Retrieval is mocked (no AI binding in the test pool); Anthropic is mocked to
// capture the outgoing payload and return a scripted surrogate answer.
const captured: { params?: unknown } = {};
vi.mock('../../src/server/ai/search', async (orig) => ({
  ...(await orig<typeof import('../../src/server/ai/search')>()),
  retrieve: async () => [
    { id: 'c1', score: 0.9, content: 'Jane Q Homeowner owes $50 at 123 Ashebrook Lane.', metadata: { filename: 'f.pdf', folder: 'documents/uuid-1/f.pdf', timestamp: 1 } },
  ],
}));
vi.mock('../../src/server/ai/anthropic', () => ({
  AssistantNotConfiguredError: class extends Error {},
  getAnthropic: () => ({
    messages: {
      stream: (params: unknown) => {
        captured.params = params;
        // Async-iterable of text deltas that echo the surrogate name back.
        async function* gen() {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The balance for ' } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: SURROGATE_NAME } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' is $50.' } };
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, finalMessage: async () => ({ stop_reason: 'end_turn' }) };
      },
    },
  }),
}));

import { answer, loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';
import { getDb } from '../../src/server/db/client';
import { owners, properties } from '../../src/server/db/schema';

// Derive the surrogate the mock will echo, from the same roster the test seeds.
let SURROGATE_NAME = '';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(properties).values({
    id: 'uuid-1', address: '123 Ashebrook Lane', addressNormalized: '123 ashebrook lane',
    status: 'active', createdAt: new Date(), updatedAt: new Date(),
  });
  await getDb(env).insert(owners).values({
    id: 'o1', propertyId: 'uuid-1', fullName: 'Jane Q Homeowner',
    phone: '(919) 555-0100', email: 'jane@realmail.com', status: 'active',
    createdAt: new Date(), updatedAt: new Date(),
  });
  const entries = await loadRosterEntries(env);
  SURROGATE_NAME = buildPseudonymizer(entries).anonymize('Jane Q Homeowner').trim();
});

async function readAll(rs: ReadableStream<string>): Promise<string> {
  const reader = rs.getReader();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

describe('assistant.answer', () => {
  it('sends NO real roster PII to Anthropic', async () => {
    await answer(env, { question: 'What does Jane Q Homeowner owe?' });
    const payload = JSON.stringify(captured.params);
    expect(payload).not.toContain('Jane Q Homeowner');
    expect(payload).not.toContain('123 Ashebrook Lane');
    expect(payload).not.toContain('919');
    expect(payload).not.toContain('jane@realmail.com');
  });

  it('de-anonymizes the streamed answer before returning it', async () => {
    const { sources, textStream } = await answer(env, { question: 'balance for Jane Q Homeowner?' });
    expect(sources).toEqual([
      { id: 'uuid-1', title: expect.any(String), category: expect.any(String), href: '/api/files/uuid-1' },
    ]);
    const text = await readAll(textStream);
    expect(text).toContain('Jane Q Homeowner'); // surrogate mapped back to the real name
    expect(text).not.toContain(SURROGATE_NAME);
  });
});
```

Note: `documents` row `uuid-1` is not seeded here, so `title`/`category` come back only if present — the test seeds a `properties` row with id `uuid-1` but `toSources` reads the `documents` table. Seed a matching `documents` row too in `beforeAll`:

```ts
  await getDb(env).insert(documents).values({
    id: 'uuid-1', title: 'Ledger', category: 'Financials', visibility: 'board',
    r2Key: 'documents/uuid-1/f.pdf', filename: 'f.pdf', sizeBytes: 1,
    contentType: 'application/pdf', uploadedAt: new Date(), updatedAt: new Date(),
  });
```

(import `documents` from schema alongside `owners, properties`).

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-assistant.test.ts`
Expected: FAIL — `answer` / `loadRosterEntries` not exported.

- [ ] **Step 4: Implement `src/server/ai/assistant.ts`**

```ts
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { owners, properties } from '../db/schema';
import { retrieve } from './search';
import { toSources, type Source } from './sources';
import { buildPseudonymizer, type PiiEntry } from './pii';
import { getAnthropic } from './anthropic';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}
export interface AnswerResult {
  sources: Source[];
  textStream: ReadableStream<string>;
}

const MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
  'You are an assistant for the neighborhood board. Answer the board member\'s',
  'question using ONLY the numbered document excerpts provided.',
  'Cite the excerpts you used by their [Source N] label. If the answer is not in',
  'the excerpts, say you could not find it in the documents. Do not invent facts.',
  'Names, addresses, phone numbers, and emails in the excerpts are placeholders —',
  'use them exactly as written; never alter, abbreviate, or reformat them.',
  'Respond with the answer only — no preamble or meta-commentary.',
].join(' ');

/** Load the roster into PII entries (active owners' names/phones/emails + property addresses). */
export async function loadRosterEntries(env: Env): Promise<PiiEntry[]> {
  const db = getDb(env);
  const [ownerRows, propRows] = await Promise.all([
    db.select({ fullName: owners.fullName, phone: owners.phone, email: owners.email })
      .from(owners)
      .where(eq(owners.status, 'active')),
    db.select({ address: properties.address }).from(properties).where(eq(properties.status, 'active')),
  ]);
  const entries: PiiEntry[] = [];
  for (const o of ownerRows) {
    if (o.fullName) entries.push({ type: 'name', value: o.fullName });
    if (o.phone) entries.push({ type: 'phone', value: o.phone });
    if (o.email) entries.push({ type: 'email', value: o.email });
  }
  for (const p of propRows) if (p.address) entries.push({ type: 'address', value: p.address });
  return entries;
}

interface DeltaEvent {
  type: string;
  delta?: { type: string; text?: string };
}
interface ClaudeStream extends AsyncIterable<DeltaEvent> {
  finalMessage(): Promise<{ stop_reason: string | null }>;
}

function claudeTextStream(stream: ClaudeStream): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            controller.enqueue(event.delta.text);
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          controller.enqueue('\n\n[The assistant declined to answer this request.]');
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export async function answer(
  env: Env,
  input: { question: string; history?: Turn[] },
): Promise<AnswerResult> {
  const chunks = await retrieve(env, input.question);
  const sources = await toSources(env, chunks);
  const pseud = buildPseudonymizer(await loadRosterEntries(env));

  const context = chunks
    .map((c, i) => `[Source ${i + 1}]\n${pseud.anonymize(c.content)}`)
    .join('\n\n');
  const history = (input.history ?? []).map((t) => ({
    role: t.role,
    content: pseud.anonymize(t.content),
  }));
  const userText =
    `Document excerpts:\n\n${context || '(no relevant excerpts found)'}\n\n` +
    `Question: ${pseud.anonymize(input.question)}`;

  const client = getAnthropic(env);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user', content: userText }],
  }) as unknown as ClaudeStream;

  const textStream = claudeTextStream(stream).pipeThrough(pseud.deanonymizeStream());
  return { sources, textStream };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-assistant.test.ts`
Expected: PASS — both the no-PII-in-payload and de-anonymized-answer cases.

- [ ] **Step 6: Commit**

```bash
git add src/server/ai/anthropic.ts src/server/ai/assistant.ts test/server/admin-assistant.test.ts
git commit -m "feat(assistant): orchestrate retrieve + pseudonymize + Claude generation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Board-only SSE endpoint — `/api/admin/assistant`

**Files:**
- Create: `src/pages/api/admin/assistant.ts`
- Test: `test/server/admin-assistant.test.ts` (append endpoint cases)

**Interfaces:**
- Consumes: `requireBoard`, `readJson`/`stringField`, `INPUT_LIMITS.assistantQuestion`, `answer` + `Turn` (Task 6), `AiSearchUnavailableError` (Task 4), `AssistantNotConfiguredError` (Task 6).
- Produces: `export const POST: APIRoute` returning an SSE stream (`sources` → `token`* → `done`, or `error`).

- [ ] **Step 1: Write the failing tests (append to `test/server/admin-assistant.test.ts`)**

```ts
import { POST } from '../../src/pages/api/admin/assistant';

async function sse(res: Response): Promise<string> {
  return await res.text();
}

describe('POST /api/admin/assistant', () => {
  it('403s a non-board caller (fail-closed)', async () => {
    // Re-mock the caller context to a homeowner for this call.
    vi.doMock('../../src/server/authz/context', () => ({
      getAuthContext: async () => ({ userId: 'h', role: 'homeowner', propertyIds: [] }),
    }));
    const { POST: POST2 } = await import('../../src/pages/api/admin/assistant');
    const res = await POST2({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'hi' }),
      }),
    } as never);
    expect(res.status).toBe(403);
    vi.doUnmock('../../src/server/authz/context');
  });

  it('400s a malformed body', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('400s an empty question', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '   ' }),
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('streams sources then tokens then done for a board caller', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'balance for Jane Q Homeowner?' }),
      }),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await sse(res);
    expect(body).toContain('event: sources');
    expect(body).toContain('event: token');
    expect(body).toContain('event: done');
    expect(body).toContain('Jane Q Homeowner'); // de-anonymized in the token stream
  });
});
```

(The top-of-file `vi.mock('../../src/server/authz/context', …)` from Task 6 provides the default board caller; the 403 case overrides it with `vi.doMock` + a fresh import.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-assistant.test.ts`
Expected: FAIL — endpoint module not found.

- [ ] **Step 3: Implement `src/pages/api/admin/assistant.ts`**

```ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { INPUT_LIMITS } from '../../../lib/types';
import { answer, type Turn } from '../../../server/ai/assistant';
import { AiSearchUnavailableError } from '../../../server/ai/search';
import { AssistantNotConfiguredError } from '../../../server/ai/anthropic';

export const prerender = false;

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseHistory(body: unknown): Turn[] {
  const raw = (body as { history?: unknown } | null)?.history;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-10)
    .map((t) => {
      const role = (t as { role?: unknown })?.role;
      const content = (t as { content?: unknown })?.content;
      if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
        return { role, content: content.slice(0, INPUT_LIMITS.assistantQuestion) };
      }
      return null;
    })
    .filter((t): t is Turn => t !== null);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const question = stringField(parsed.value, 'question');
  if (!question) return new Response('question is required', { status: 400 });
  if (question.length > INPUT_LIMITS.assistantQuestion) {
    return new Response('question is too long', { status: 400 });
  }
  const history = parseHistory(parsed.value);

  let result;
  try {
    result = await answer(env, { question, history });
  } catch (err) {
    if (err instanceof AssistantNotConfiguredError) {
      return new Response("The assistant isn't configured", { status: 500 });
    }
    if (err instanceof AiSearchUnavailableError) {
      return new Response('Document search is temporarily unavailable', { status: 503 });
    }
    throw err;
  }

  const { sources, textStream } = result;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseFrame('sources', sources));
      const reader = textStream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(sseFrame('token', { text: value }));
        }
        controller.enqueue(sseFrame('done', {}));
      } catch {
        controller.enqueue(sseFrame('error', { message: 'The assistant hit an error. Please try again.' }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-assistant.test.ts`
Expected: PASS (all orchestration + endpoint cases).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/admin/assistant.ts test/server/admin-assistant.test.ts
git commit -m "feat(assistant): board-only SSE endpoint for the document assistant" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Admin chat UI — `AssistantChat`

**Files:**
- Create: `src/components/admin/AssistantChat.tsx`
- Modify: `src/components/admin/AdminApp.tsx` (import + add to `SECTIONS`)
- Test: `src/components/admin/AssistantChat.test.tsx`

**Interfaces:**
- Consumes: the `/api/admin/assistant` SSE endpoint (Task 7).
- Produces: a default-exported `AssistantChat` React component.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/admin/AssistantChat.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AssistantChat from './AssistantChat';

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => vi.restoreAllMocks());

describe('AssistantChat', () => {
  it('sends a question and renders the streamed answer + sources', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        `event: sources\ndata: ${JSON.stringify([{ id: 'd1', title: 'Bylaws', category: 'Governing Documents', href: '/api/files/d1' }])}\n\n`,
        `event: token\ndata: ${JSON.stringify({ text: 'The late fee ' })}\n\n`,
        `event: token\ndata: ${JSON.stringify({ text: 'is $25.' })}\n\n`,
        `event: done\ndata: {}\n\n`,
      ]),
    );

    render(<AssistantChat />);
    fireEvent.change(screen.getByPlaceholderText(/ask/i), { target: { value: 'late fee?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/The late fee is \$25\./)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Bylaws/ })).toHaveAttribute('href', '/api/files/d1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/AssistantChat.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/components/admin/AssistantChat.tsx`**

```tsx
import { useRef, useState, type FormEvent } from 'react';

interface Source {
  id: string;
  title: string;
  category: string;
  href: string;
}
interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

export default function AssistantChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const historyRef = useRef<Message[]>([]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    setError('');
    setInput('');
    setBusy(true);

    const userMsg: Message = { role: 'user', content: question };
    const priorHistory = historyRef.current.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, userMsg, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch('/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, history: priorHistory }),
      });
      if (!res.ok || !res.body) {
        setError(await res.text().catch(() => 'The assistant is unavailable.'));
        setMessages((m) => m.slice(0, -1)); // drop the empty assistant bubble
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let answer = '';
      let sources: Source[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const evLine = frame.match(/^event: (.+)$/m);
          const dataLine = frame.match(/^data: (.+)$/m);
          if (!evLine || !dataLine) continue;
          const data = JSON.parse(dataLine[1]);
          if (evLine[1] === 'sources') sources = data as Source[];
          else if (evLine[1] === 'token') {
            answer += (data as { text: string }).text;
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { role: 'assistant', content: answer, sources };
              return next;
            });
          } else if (evLine[1] === 'error') {
            setError((data as { message: string }).message);
          }
        }
      }
      const finalAssistant: Message = { role: 'assistant', content: answer, sources };
      historyRef.current = [...historyRef.current, userMsg, finalAssistant];
    } catch {
      setError('Network error. Please try again.');
      setMessages((m) => m.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="assistant">
      <header>
        <p className="eyebrow">Board tools</p>
        <h1 className="page-title">Document Assistant</h1>
        <p className="notice">
          AI-generated from your documents — verify important details before acting. Scanned or
          spreadsheet content may be incomplete, and answers can be wrong. Resident names and
          contact details are pseudonymized before the question is sent to the AI provider.
        </p>
      </header>

      <div className="assistant__log">
        {messages.map((m, i) => (
          <div key={i} className={`assistant__msg assistant__msg--${m.role}`}>
            <div className="assistant__bubble">{m.content || (m.role === 'assistant' ? '…' : '')}</div>
            {m.sources && m.sources.length > 0 && (
              <ul className="assistant__sources">
                {m.sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.href} target="_blank" rel="noopener noreferrer">
                      {s.title}
                    </a>
                    <span className="assistant__cat"> · {s.category}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {error && <div className="form-message form-message--error">{error}</div>}

      <form className="assistant__form" onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          placeholder="Ask a question about the documents…"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/admin/AssistantChat.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire it into `src/components/admin/AdminApp.tsx`**

Add the import after the other manager imports:

```tsx
import AssistantChat from './AssistantChat';
```

Add this entry to the `SECTIONS` array (place it first so it's the default landing section, or after `documents` — either is fine; first is recommended so the board lands on the assistant):

```tsx
  { key: 'assistant', label: 'Assistant', render: () => <AssistantChat /> },
```

- [ ] **Step 6: Run the jsdom suite + typecheck**

Run: `npm test`
Expected: PASS (all jsdom specs, including the new one).

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/admin/AssistantChat.tsx src/components/admin/AssistantChat.test.tsx src/components/admin/AdminApp.tsx
git commit -m "feat(assistant): admin chat UI wired into the admin panel" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Documentation + minimal CSS + full gate

**Files:**
- Modify: `CLAUDE.md`, `SETUP.md`, `SECURITY.md`, `CHANGELOG.md`
- Modify: `src/styles/global.css` (assistant layout classes referenced by the UI)

**Interfaces:** none (docs + styles).

- [ ] **Step 1: Add minimal styles to `src/styles/global.css`**

Append (mirroring the existing admin/utility class conventions):

```css
.assistant__log { display: flex; flex-direction: column; gap: 16px; margin: 24px 0; }
.assistant__msg { display: flex; flex-direction: column; gap: 6px; }
.assistant__msg--user { align-items: flex-end; }
.assistant__bubble { max-width: 90%; padding: 10px 14px; border-radius: 12px; background: var(--surface, #f4f1ea); white-space: pre-wrap; }
.assistant__msg--user .assistant__bubble { background: var(--accent, #2a4d69); color: #fff; }
.assistant__sources { list-style: none; padding: 0; margin: 2px 0 0; font-size: 0.85em; }
.assistant__cat { color: var(--muted, #6b7280); }
.assistant__form { display: flex; gap: 8px; }
.assistant__form input { flex: 1; }
```

(If the referenced CSS variables don't exist in `global.css`, use the concrete values already used elsewhere in that file — check the existing `:root` block and match it.)

- [ ] **Step 2: Update `CLAUDE.md`**

Under **HTTP endpoints**, add to the board-only list: `POST /api/admin/assistant` (board-only document Q&A; SSE). Under **Server code (`src/server/`)**, add: `ai/` (document assistant — `search.ts` AI Search retrieval, `pii.ts` reversible roster-based PII pseudonymizer, `sources.ts` chunk→document mapping, `anthropic.ts` client, `assistant.ts` orchestration). Under **Cloudflare bindings**, add: `AI` (Workers AI / AI Search binding) + the `AI_SEARCH_INSTANCE` var + `ANTHROPIC_API_KEY` secret.

- [ ] **Step 3: Update `SETUP.md`**

Add a new numbered section "AI Document Assistant (optional)": (a) create an AI Search instance in the Cloudflare dashboard pointed at the `ashebrook-hoa-docs` R2 bucket; note the 4 MB/file cap and that `.xlsx` files are not indexed; (b) set the instance name in `wrangler.toml` `AI_SEARCH_INSTANCE`; (c) `wrangler secret put ANTHROPIC_API_KEY`; (d) note the assistant only works once documents are imported (§7 docs import) so the index has content; (e) explain the pseudonymization behavior and its best-effort limits in one paragraph.

- [ ] **Step 4: Update `SECURITY.md`**

Add a bullet to the security model: the admin document assistant is board-only (`requireBoard`, fail-closed); answer generation sends retrieved document excerpts to Anthropic; **known resident PII (names/addresses/phones/emails from the roster) plus any email/phone is pseudonymized before transmission** — this is **best-effort** and does not cover non-resident names, standalone surnames, or OCR-garbled text; document titles are never sent (citations use index labels).

- [ ] **Step 5: Update `CHANGELOG.md` `[Unreleased]`**

`### Added`: "Board-only AI document assistant — ask questions about the document library and get streamed, cited answers (Cloudflare AI Search + Claude)." `### Security`: "The assistant pseudonymizes known resident PII before sending document excerpts to Anthropic (best-effort, roster-based)."

- [ ] **Step 6: Run the full gate**

Run: `npm run format:check && npm run check && npm test && npm run test:server && npm run build`
Expected: all PASS. (If `format:check` fails, run `npm run format` and re-run.)

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md SETUP.md SECURITY.md CHANGELOG.md src/styles/global.css
git commit -m "docs(assistant): document the AI assistant + pseudonymization; add styles" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Board-only SSE endpoint → Task 7. AI Search retrieval → Task 4. Claude Opus 4.8 generation → Task 6. Citations → Task 5 + Task 8. PII pseudonymization (roster + regex, realistic surrogates, single-pass inbound, streaming outbound) → Tasks 2–3, used in Task 6. Cite-by-index / titles-not-sent → Task 6 prompt + Task 5 sources. No-PII-in-payload guardrail test → Task 6. Config/secret/binding + INPUT_LIMITS → Task 1. UI + disclaimer → Task 8. Docs (CLAUDE/SETUP/SECURITY/CHANGELOG) → Task 9. Error handling (403/500/503/400/empty/refusal) → Tasks 6–7. All spec sections mapped.
- **Dependency noted:** the assistant is only useful once documents are imported to prod R2 (`docs:import --commit`) so AI Search has content — captured in SETUP.md (Task 9 Step 3) and the design spec.

**Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step contains complete code; every test contains real assertions.

**Type consistency:** `AiSearchChunk`/`AiBinding` (Task 1) consumed by `retrieve` (Task 4), `toSources` (Task 5), `answer` (Task 6). `Source` (Task 5) flows through `answer` (Task 6) → endpoint (Task 7) → UI (Task 8) with the same shape `{ id, title, category, href }`. `Pseudonymizer` (Tasks 2–3) used by `answer` (Task 6). `Turn`/`AnswerResult` (Task 6) consumed by the endpoint (Task 7). `answer`, `loadRosterEntries`, `getAnthropic`, `AssistantNotConfiguredError`, `AiSearchUnavailableError` names are consistent across producer/consumer tasks.

**Known follow-ups (not blockers):** verify the `[ai]` binding surfaces through the Astro adapter (Task 1 Step 6); if not, add it in the dashboard. Streaming SSE + refusal handling covered; a future task could add conversation persistence, an upload-time Force Sync, and a Workers-AI NER pass (all out of scope per the spec).
