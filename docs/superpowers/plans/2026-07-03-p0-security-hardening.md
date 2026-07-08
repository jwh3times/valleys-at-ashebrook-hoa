# P0 Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six P0 security/abuse findings (#1–6) from `private/improvements.md`: rate-limit the SMS-sending verification endpoint, constrain document upload/download, set baseline security headers, key+constant-time the OTP hashes, make board handoff a deliberate documented workflow while closing impersonation/ban, and validate `settings` blobs.

**Architecture:** An Astro SSR app on Cloudflare Workers (D1 via Drizzle, R2, KV). API routes live under `src/pages/api/`; server logic under `src/server/`; React admin islands under `src/components/admin/`. Changes are behavior-preserving hardening plus one small admin UI (Board members). Every change is driven by a test in the existing tiers.

**Tech Stack:** TypeScript, Astro, Drizzle ORM (D1/SQLite), Better Auth (+ admin plugin), Cloudflare KV/R2, Vitest (jsdom + `@cloudflare/vitest-pool-workers`), React.

## Global Constraints

- **Node:** `>=26.4.0` (pinned in `.nvmrc`; run `nvm use` before commands).
- **Runtime bindings/secrets:** read via `import { env } from 'cloudflare:workers'`. `KV`, `DATABASE`, `DOCS`, `SESSION` are bound in `wrangler.toml`; `BETTER_AUTH_SECRET` is a wrangler secret (mirrored in tests as `test-secret-not-real`).
- **Fail-closed:** anonymous → visitor; unknown role → most restrictive. Never weaken this.
- **Formatting/CI:** CI enforces `npm run format:check`, `npm run check` (Astro + tsc), `npm test` (jsdom), then `npm run build`. Run `npm run format` before each commit. (`npm run test:server` is not yet in CI — that's finding #7, out of scope — so **run it locally** for server-test tasks.)
- **Test commands:**
  - jsdom/unit: `npx vitest run <path>` (config `vitest.config.ts`, the default).
  - Worker/D1 integration: `npx vitest run --config vitest.workers.config.ts <path>` (files under `test/server/**`).
- **Commit messages** end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Delivery:** four branches off `main`, one per PR group (A/B/C/D). Create the branch at the first task of each group. Do not push or open PRs unless the operator asks.

---

## PR A — Quick wins (findings #4, #6, #3)

Branch: `git checkout main && git pull && git checkout -b feat/security-headers-otp-settings`

### Task A1: HMAC-keyed, constant-time OTP hashes (#4)

**Files:**

- Modify: `src/server/verification/codes.ts`
- Modify: `src/server/verification/property.ts:78`, `:127`
- Test: `test/unit/codes.test.ts` (modify), `test/server/verification.test.ts:78,124,135` (modify seeds)

**Interfaces:**

- Produces: `hashCode(code: string, secret: string): Promise<string>`, `verifyCode(code: string, hash: string, secret: string): Promise<boolean>` (both now require `secret`). `generateCode()`, `MAX_ATTEMPTS`, `CODE_TTL_MS` unchanged.
- Consumes: `env.BETTER_AUTH_SECRET` inside `property.ts`.

- [ ] **Step 1: Update the unit test to the keyed, constant-time contract**

Replace `test/unit/codes.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
} from '../../src/server/verification/codes';

const SECRET = 'unit-test-secret';

describe('codes', () => {
  it('generates a 6-digit numeric code', () => {
    expect(generateCode()).toMatch(/^\d{6}$/);
  });
  it('verifies a matching code and rejects a wrong one', async () => {
    const hash = await hashCode('123456', SECRET);
    expect(await verifyCode('123456', hash, SECRET)).toBe(true);
    expect(await verifyCode('000000', hash, SECRET)).toBe(false);
  });
  it('is keyed: the same code hashes differently under a different secret', async () => {
    expect(await hashCode('123456', 'a')).not.toBe(
      await hashCode('123456', 'b'),
    );
    expect(await verifyCode('123456', await hashCode('123456', 'a'), 'b')).toBe(
      false,
    );
  });
  it('produces a 64-char hex digest (HMAC-SHA-256)', async () => {
    expect(await hashCode('123456', SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('exposes an attempt cap', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/codes.test.ts`
Expected: FAIL — `hashCode`/`verifyCode` are called with 2/3 args but currently accept 1/2; the "keyed" and "64-char hex" assertions fail.

- [ ] **Step 3: Rewrite `codes.ts`**

Replace the body of `src/server/verification/codes.ts` with:

```ts
export const MAX_ATTEMPTS = 5;
export const CODE_TTL_MS = 600_000;

export function generateCode(): string {
  // Rejection sampling avoids the modulo bias of `random % 1_000_000`:
  // discard the top partial bucket so every 6-digit value is equally likely.
  const range = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  let n = crypto.getRandomValues(new Uint32Array(1))[0];
  while (n >= limit) {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (n % range).toString().padStart(6, '0');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// Keyed HMAC-SHA-256 so a leaked D1 backup can't be reversed with a
// precomputed 1M-row rainbow table the way a bare SHA-256 digest can.
export async function hashCode(code: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time hex comparison: no early return on the first differing char,
// so verification time doesn't leak how much of the digest matched.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyCode(
  code: string,
  hash: string,
  secret: string,
): Promise<boolean> {
  return timingSafeEqualHex(await hashCode(code, secret), hash);
}
```

- [ ] **Step 4: Thread the secret through `property.ts`**

In `src/server/verification/property.ts`:

- Line ~78 (inside `requestPropertyVerification`, the insert): change
  `codeHash: await hashCode(code),` → `codeHash: await hashCode(code, env.BETTER_AUTH_SECRET),`
- Line ~127 (inside `confirmPropertyVerification`): change
  `if (!(await verifyCode(code, pv.codeHash))) {` → `if (!(await verifyCode(code, pv.codeHash, env.BETTER_AUTH_SECRET))) {`

- [ ] **Step 5: Update the server verification test seeds**

In `test/server/verification.test.ts`, the three direct `hashCode('…')` seed calls must use the same secret the handler uses (`env.BETTER_AUTH_SECRET`, already `test-secret-not-real` in the workers config):

- Line ~78: `codeHash: await hashCode('123456'),` → `codeHash: await hashCode('123456', env.BETTER_AUTH_SECRET),`
- Line ~124: `codeHash: await hashCode('111111'),` → `codeHash: await hashCode('111111', env.BETTER_AUTH_SECRET),`
- Line ~135: `codeHash: await hashCode('654321'),` → `codeHash: await hashCode('654321', env.BETTER_AUTH_SECRET),`

- [ ] **Step 6: Run unit + server tests to verify they pass**

Run: `npx vitest run test/unit/codes.test.ts`
Expected: PASS.
Run: `npx vitest run --config vitest.workers.config.ts test/server/verification.test.ts`
Expected: PASS (confirm/lockout/fan-out/all-fail flows unchanged; hashes now keyed).

- [ ] **Step 7: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/server/verification/codes.ts src/server/verification/property.ts test/unit/codes.test.ts test/server/verification.test.ts
git commit -m "$(cat <<'EOF'
fix(verification): HMAC-key OTP hashes and compare constant-time (#4)

Bare SHA-256 over a 6-digit space is trivially reversible from a leaked
D1 backup. Switch hashCode/verifyCode to HMAC-SHA-256 keyed with
BETTER_AUTH_SECRET and compare digests in constant time.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: Validate settings on write, normalize dues on read (#6)

**Files:**

- Modify: `src/lib/types.ts` (add `normalizeDuesSettings`)
- Modify: `src/pages/api/admin/site.ts` (normalize before persist)
- Modify: `src/pages/api/admin/dues.ts` (normalize before persist)
- Modify: `src/pages/api/content/dues.ts` (normalize on read)
- Test: `test/unit/dues-normalize.test.ts` (create), `test/server/content-dues-normalize.test.ts` (create)

**Interfaces:**

- Produces: `normalizeDuesSettings(raw: unknown): DuesSettings` (exported from `src/lib/types.ts`).
- Consumes: existing `normalizeSiteSettings`, `DEFAULT_DUES_SETTINGS`, `PaymentOption`, `DuesSettings`.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/dues-normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeDuesSettings,
  DEFAULT_DUES_SETTINGS,
} from '../../src/lib/types';

describe('normalizeDuesSettings', () => {
  it('fills defaults for a non-object', () => {
    expect(normalizeDuesSettings(null)).toEqual(DEFAULT_DUES_SETTINGS);
  });
  it('coerces fields to strings and drops unknown keys', () => {
    const out = normalizeDuesSettings({
      amount: 250,
      dueDate: 'Jan 31',
      notes: null,
      paymentOptions: [],
      evil: '<script>',
    });
    expect(out).toEqual({
      amount: DEFAULT_DUES_SETTINGS.amount, // 250 is not a string -> fallback
      dueDate: 'Jan 31',
      notes: DEFAULT_DUES_SETTINGS.notes,
      paymentOptions: [],
    });
    expect('evil' in out).toBe(false);
  });
  it('keeps http(s) payment urls and drops others', () => {
    const out = normalizeDuesSettings({
      amount: '$250',
      dueDate: '',
      notes: '',
      paymentOptions: [
        { label: 'PayPal', details: 'pay', url: 'https://paypal.me/x' },
        { label: 'Bad', details: 'x', url: 'javascript:alert(1)' },
        { label: 'NoUrl', details: 'mail a check' },
      ],
    });
    expect(out.paymentOptions[0].url).toBe('https://paypal.me/x');
    expect(out.paymentOptions[1].url).toBeUndefined();
    expect(out.paymentOptions[2].url).toBeUndefined();
  });
  it('replaces a non-array paymentOptions with []', () => {
    expect(
      normalizeDuesSettings({ paymentOptions: 'nope' }).paymentOptions,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/dues-normalize.test.ts`
Expected: FAIL — `normalizeDuesSettings` is not exported.

- [ ] **Step 3: Add `normalizeDuesSettings` to `src/lib/types.ts`**

Immediately after the `DEFAULT_DUES_SETTINGS` declaration, add:

```ts
/**
 * Coerce a raw parsed dues blob into a complete DuesSettings: string fields,
 * a well-formed paymentOptions array, and payment urls restricted to http(s)
 * (the url is rendered as an <a href> in DuesInfo.tsx). Unknown keys are dropped.
 */
export function normalizeDuesSettings(raw: unknown): DuesSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : fallback;
  const rawOptions = Array.isArray(r.paymentOptions) ? r.paymentOptions : [];
  const paymentOptions: PaymentOption[] = rawOptions.map((o) => {
    const opt = (o && typeof o === 'object' ? o : {}) as Record<
      string,
      unknown
    >;
    const option: PaymentOption = {
      label: str(opt.label, ''),
      details: str(opt.details, ''),
    };
    if (typeof opt.url === 'string') {
      try {
        const u = new URL(opt.url);
        if (u.protocol === 'http:' || u.protocol === 'https:')
          option.url = opt.url;
      } catch {
        /* drop unparseable url */
      }
    }
    return option;
  });
  return {
    amount: str(r.amount, DEFAULT_DUES_SETTINGS.amount),
    dueDate: str(r.dueDate, DEFAULT_DUES_SETTINGS.dueDate),
    notes: str(r.notes, DEFAULT_DUES_SETTINGS.notes),
    paymentOptions,
  };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run test/unit/dues-normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Normalize before persisting (site + dues writes)**

In `src/pages/api/admin/site.ts`: add the import and normalize:

```ts
import { normalizeSiteSettings } from '../../../lib/types';
```

Change `const value = JSON.stringify(await request.json());`
to `const value = JSON.stringify(normalizeSiteSettings(await request.json()));`

In `src/pages/api/admin/dues.ts`: add the import and normalize:

```ts
import { normalizeDuesSettings } from '../../../lib/types';
```

Change `const value = JSON.stringify(await request.json());`
to `const value = JSON.stringify(normalizeDuesSettings(await request.json()));`

- [ ] **Step 6: Normalize the public dues read**

In `src/pages/api/content/dues.ts`: add the import and normalize the parsed row:

```ts
import {
  DEFAULT_DUES_SETTINGS,
  normalizeDuesSettings,
} from '../../../lib/types';
```

Change the `try` block body from `return Response.json(JSON.parse(row.value));`
to `return Response.json(normalizeDuesSettings(JSON.parse(row.value)));`

- [ ] **Step 7: Write the failing server test for the read normalization**

Create `test/server/content-dues-normalize.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/content/dues';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('GET /api/content/dues normalization', () => {
  it('strips unknown keys and non-http(s) payment urls from a mangled stored blob', async () => {
    const now = new Date();
    await getDb(env)
      .insert(settings)
      .values({
        key: 'dues',
        value: JSON.stringify({
          amount: '$250',
          dueDate: 'Jan 31',
          notes: 'late fee $25',
          evil: '<script>',
          paymentOptions: [
            { label: 'X', details: 'y', url: 'javascript:alert(1)' },
          ],
        }),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify({ amount: '$250' }), updatedAt: now },
      });

    const res = await GET({} as never);
    const body = (await res.json()) as {
      amount: string;
      paymentOptions: { url?: string }[];
      evil?: unknown;
    };
    expect(body.amount).toBe('$250');
    expect('evil' in body).toBe(false);
    expect(body.paymentOptions[0].url).toBeUndefined();
  });
});
```

Note: the `onConflictDoUpdate` keeps this test independent of row-existence ordering; on conflict it overwrites with a minimal blob whose `amount` is still `$250`, so the assertion holds either way. If you prefer, delete the `settings` row in a `beforeEach` instead.

- [ ] **Step 8: Run server tests to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/content-dues-normalize.test.ts test/server/admin-settings-board.test.ts`
Expected: PASS (the existing `admin-settings-board` test's `toMatchObject({amount:'250', notes:'annual'})` still holds — normalization is a superset).

- [ ] **Step 9: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/lib/types.ts src/pages/api/admin/site.ts src/pages/api/admin/dues.ts src/pages/api/content/dues.ts test/unit/dues-normalize.test.ts test/server/content-dues-normalize.test.ts
git commit -m "$(cat <<'EOF'
fix(settings): normalize site/dues on write and dues on read (#6)

Persist normalized SiteSettings/DuesSettings instead of raw JSON, and
normalize the public dues blob on read. Drops unknown keys and restricts
PaymentOption.url to http(s) (it renders as an href).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: Baseline security headers on every response (#3)

**Files:**

- Modify: `src/middleware.ts`
- Modify: `SETUP.md` (HSTS note)
- Test: `test/server/middleware-headers.test.ts` (create)

**Interfaces:**

- Produces: security headers on every response (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Content-Security-Policy-Report-Only`), including redirects.

- [ ] **Step 1: Write the failing test**

Create `test/server/middleware-headers.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { onRequest } from '../../src/middleware';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function fakeContext(path: string) {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url),
    url,
    locals: {} as App.Locals,
    redirect: (p: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location: p } }),
  };
}

const call = (path: string, next: () => Promise<Response>) =>
  (
    onRequest as never as (
      c: unknown,
      n: () => Promise<Response>,
    ) => Promise<Response>
  )(fakeContext(path), next);

describe('security headers', () => {
  it('sets baseline headers on a normal page response', async () => {
    const res = await call('/', async () => new Response('ok'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(res.headers.get('permissions-policy')).toBeTruthy();
    expect(res.headers.get('content-security-policy-report-only')).toContain(
      'calendar.google.com',
    );
  });

  it('sets headers on the /admin redirect too', async () => {
    const res = await call('/admin', async () => new Response('ok'));
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/middleware-headers.test.ts`
Expected: FAIL — headers absent.

- [ ] **Step 3: Rewrite `src/middleware.ts`**

Replace the file with:

```ts
// defineMiddleware is an identity function at runtime; avoid the astro:middleware
// virtual module so this file can be imported in both the Astro build and the
// Cloudflare Workers-pool Vitest tests (which do not have astro:middleware available).
import type { MiddlewareHandler } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from './server/authz/context';
import { getSiteSettings } from './server/content/settings';
import { DEFAULT_SITE_SETTINGS } from './lib/types';

// Enumerated from the code's external dependencies: Google Fonts, the Google
// Calendar embed (frame), Turnstile (script+frame), Web3Forms (connect).
// Shipped Report-Only first: Astro injects inline styles + island hydration, so
// enforce-mode is flipped in a follow-up once no legitimate resource is blocked.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://api.web3forms.com",
  'frame-src https://calendar.google.com https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function applySecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  headers.set('Content-Security-Policy-Report-Only', CSP);
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const ctx = await getAuthContext(context.request, env);
  context.locals.authContext = ctx;
  const path = context.url.pathname;

  // Surface site settings (incl. officialMode) to page renders. Skip the DB read for
  // API/file routes, which do not render chrome — they get inert defaults.
  context.locals.site = path.startsWith('/api')
    ? { ...DEFAULT_SITE_SETTINGS }
    : await getSiteSettings(env);

  let response: Response;
  if (path.startsWith('/admin') && ctx?.role !== 'board') {
    response = context.redirect('/login', 302);
  } else if (
    path.startsWith('/homeowner') &&
    (!ctx || ctx.role === 'visitor')
  ) {
    response = context.redirect('/login', 302);
  } else {
    response = await next();
  }
  applySecurityHeaders(response.headers);
  return response;
};
```

- [ ] **Step 4: Run header + existing middleware tests to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/middleware-headers.test.ts test/server/middleware.test.ts test/server/middleware-site.test.ts`
Expected: PASS (redirect behavior unchanged; headers now present).

- [ ] **Step 5: Add the HSTS note to `SETUP.md`**

Append a short subsection (find the deployment/DNS area of `SETUP.md`; add near the Cloudflare zone settings):

```markdown
### Security headers

The Worker sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`, and a **Report-Only** Content-Security-Policy on every
response. Two settings live at the Cloudflare **zone** level, not in code:

- **HSTS:** enable in the dashboard → SSL/TLS → Edge Certificates → HTTP Strict
  Transport Security (recommend `max-age=15552000`, includeSubDomains once you've
  confirmed every subdomain is HTTPS).
- After watching the browser console for CSP violations in Report-Only mode and
  confirming nothing legitimate is blocked, flip `Content-Security-Policy-Report-Only`
  to `Content-Security-Policy` in `src/middleware.ts`.
```

- [ ] **Step 6: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/middleware.ts SETUP.md test/server/middleware-headers.test.ts
git commit -m "$(cat <<'EOF'
feat(security): baseline security headers on every response (#3)

nosniff, X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy, and
a Report-Only CSP (Google Fonts/Calendar, Turnstile, Web3Forms allowed),
applied to redirects and rendered responses alike. HSTS documented as a
zone-level setting in SETUP.md.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> PR A is complete. Run the full local gate before opening the PR: `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.

---

## PR B — Rate-limit `/api/verify/request` (#1)

Branch: `git checkout main && git checkout -b feat/verify-rate-limit`

### Task B1: Rate-limit module (KV counters)

**Files:**

- Create: `src/server/verification/rate-limit.ts`
- Test: `test/server/rate-limit.test.ts` (create)

**Interfaces:**

- Produces:
  - `checkUserRateLimit(env: Env, userId: string): Promise<{ ok: true } | { ok: false; reason: 'cooldown' | 'daily' }>`
  - `checkPropertyRateLimit(env: Env, propertyId: string): Promise<{ ok: true } | { ok: false; reason: 'daily' }>`
  - `setCooldown(env: Env, userId: string): Promise<void>`
  - `recordVerificationSend(env: Env, userId: string, propertyId: string): Promise<void>`
  - `DAILY_LIMIT: number`

- [ ] **Step 1: Write the failing test**

Create `test/server/rate-limit.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  checkUserRateLimit,
  checkPropertyRateLimit,
  setCooldown,
  recordVerificationSend,
  DAILY_LIMIT,
} from '../../src/server/verification/rate-limit';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('verification rate limiting', () => {
  it('allows a fresh user', async () => {
    expect(await checkUserRateLimit(env, 'rl-fresh')).toEqual({ ok: true });
  });

  it('blocks with cooldown after setCooldown', async () => {
    await setCooldown(env, 'rl-cool');
    expect(await checkUserRateLimit(env, 'rl-cool')).toEqual({
      ok: false,
      reason: 'cooldown',
    });
  });

  it('blocks a user after DAILY_LIMIT sends', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) {
      await recordVerificationSend(env, 'rl-day', `prop-${i}`);
    }
    // A distinct check that ignores the cooldown key: use a user with only day counts.
    const res = await checkUserRateLimit(env, 'rl-day');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('daily');
  });

  it('blocks a property after DAILY_LIMIT sends', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) {
      await recordVerificationSend(env, `u-${i}`, 'prop-hot');
    }
    const res = await checkPropertyRateLimit(env, 'prop-hot');
    expect(res.ok).toBe(false);
  });
});
```

Note: `checkUserRateLimit` checks the cooldown key first. In the `rl-day` test we never call `setCooldown` for `rl-day`, so the daily branch is what trips. Keep the two users (`rl-cool`, `rl-day`) distinct so the cooldown and daily branches are tested independently.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/rate-limit.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/server/verification/rate-limit.ts`**

```ts
// Abuse throttle for /api/verify/request, which fans real SMS/email to every
// owner contact on a home. Counting property_verifications rows is unreliable
// (each request deletes the caller's prior unconsumed code), so use KV counters.
// Read-modify-write on KV is not atomic; at HOA request volumes the small race
// is acceptable and the cooldown blocks bursts regardless.

const COOLDOWN_SECONDS = 120; // 1 request / 2 min per user
export const DAILY_LIMIT = 5; // per user AND per property, rolling ~24h
const DAY_SECONDS = 86_400;

async function count(env: Env, key: string): Promise<number> {
  return Number((await env.KV.get(key)) ?? '0');
}

export async function checkUserRateLimit(
  env: Env,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: 'cooldown' | 'daily' }> {
  if (await env.KV.get(`verif:cooldown:${userId}`))
    return { ok: false, reason: 'cooldown' };
  if ((await count(env, `verif:day:user:${userId}`)) >= DAILY_LIMIT)
    return { ok: false, reason: 'daily' };
  return { ok: true };
}

export async function checkPropertyRateLimit(
  env: Env,
  propertyId: string,
): Promise<{ ok: true } | { ok: false; reason: 'daily' }> {
  if ((await count(env, `verif:day:prop:${propertyId}`)) >= DAILY_LIMIT)
    return { ok: false, reason: 'daily' };
  return { ok: true };
}

export async function setCooldown(env: Env, userId: string): Promise<void> {
  await env.KV.put(`verif:cooldown:${userId}`, '1', {
    expirationTtl: COOLDOWN_SECONDS,
  });
}

export async function recordVerificationSend(
  env: Env,
  userId: string,
  propertyId: string,
): Promise<void> {
  const userKey = `verif:day:user:${userId}`;
  const propKey = `verif:day:prop:${propertyId}`;
  await env.KV.put(userKey, String((await count(env, userKey)) + 1), {
    expirationTtl: DAY_SECONDS,
  });
  await env.KV.put(propKey, String((await count(env, propKey)) + 1), {
    expirationTtl: DAY_SECONDS,
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Format & commit**

```bash
npm run check
npm run format
git add src/server/verification/rate-limit.ts test/server/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(verification): KV-backed rate-limit primitives (#1)

Per-user cooldown + per-user and per-property daily caps for the
verification-request flow. Counters live in KV; no schema change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B2: Enforce the limit in the request path

**Files:**

- Modify: `src/server/verification/property.ts` (per-property check + record on send; extend return type)
- Modify: `src/pages/api/verify/request.ts` (per-user pre-check, cooldown, 429)
- Test: `test/server/verify-request-ratelimit.test.ts` (create)

**Interfaces:**

- Consumes: rate-limit primitives from B1.
- Produces: `requestPropertyVerification` return type becomes
  `Promise<{ ok: true } | { ok: false; queued: true } | { ok: false; rateLimited: true }>`.

- [ ] **Step 1: Write the failing test**

Create `test/server/verify-request-ratelimit.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// Signed-in user + captcha pass; senders are inert so no real network.
// (vi.mock calls are hoisted above the imports below by Vitest.)
vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({
    userId: 'rluser',
    role: 'homeowner',
    propertyIds: [],
  }),
}));
vi.mock('../../src/server/authz/turnstile', () => ({
  verifyTurnstile: async () => true,
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '../../src/pages/api/verify/request';
import { getDb } from '../../src/server/db/client';
import { properties, owners } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  await getDb(env).insert(properties).values({
    id: 'rl-prop',
    address: '5 Rate St',
    addressNormalized: '5 rate st',
    unit: null,
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env).insert(owners).values({
    id: 'rl-own',
    propertyId: 'rl-prop',
    fullName: 'Rate Owner',
    phone: null,
    email: 'rate@example.com',
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
});

function req() {
  return POST({
    request: new Request('http://localhost/api/verify/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: '5 Rate St',
        channel: 'email',
        turnstileToken: 't',
      }),
    }),
  } as never);
}

describe('POST /api/verify/request rate limiting', () => {
  it('sends the first request then 429s the immediate retry (cooldown)', async () => {
    const first = await req();
    expect(first.status).toBe(200);
    const second = await req();
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      rateLimited?: boolean;
      message?: string;
    };
    expect(body.rateLimited).toBe(true);
    expect(typeof body.message).toBe('string');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/verify-request-ratelimit.test.ts`
Expected: FAIL — the second request currently returns 200 (no rate limiting).

- [ ] **Step 3: Add the per-property check + record-on-send in `property.ts`**

In `src/server/verification/property.ts`:

Add to the imports:

```ts
import { checkPropertyRateLimit, recordVerificationSend } from './rate-limit';
```

Change the `requestPropertyVerification` return type:

```ts
): Promise<
  { ok: true } | { ok: false; queued: true } | { ok: false; rateLimited: true }
> {
```

After the `recipients.length === 0` queue block (i.e. once a property + recipients exist, just before `await db.delete(propertyVerifications)...`), insert:

```ts
const prl = await checkPropertyRateLimit(env, property.id);
if (!prl.ok) return { ok: false, rateLimited: true };
```

In the success path, immediately before the final `return { ok: true };`, insert:

```ts
await recordVerificationSend(env, userId, property.id);
```

- [ ] **Step 4: Add the per-user pre-check, cooldown, and 429 in `request.ts`**

Replace `src/pages/api/verify/request.ts` with:

```ts
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { requestPropertyVerification } from '../../../server/verification/property';
import { verifyTurnstile } from '../../../server/authz/turnstile';
import {
  checkUserRateLimit,
  setCooldown,
} from '../../../server/verification/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const rl = await checkUserRateLimit(env, ctx.userId);
  if (!rl.ok) {
    const message =
      rl.reason === 'cooldown'
        ? 'Please wait a couple of minutes before requesting another code.'
        : "You've reached the daily limit for verification requests. Please try again tomorrow.";
    return Response.json(
      { ok: false, rateLimited: true, message },
      { status: 429 },
    );
  }

  const { address, channel, turnstileToken } = (await request.json()) as {
    address: string;
    channel: string;
    turnstileToken: string;
  };
  if (channel !== 'email' && channel !== 'sms')
    return new Response('Bad channel', { status: 400 });
  if (!(await verifyTurnstile(env, turnstileToken, request)))
    return new Response('Bad captcha', { status: 400 });

  // Throttle re-submits regardless of outcome (incl. queued/not-found).
  await setCooldown(env, ctx.userId);

  const result = await requestPropertyVerification(
    env,
    ctx.userId,
    address,
    channel,
  );
  if ('rateLimited' in result && result.rateLimited) {
    return Response.json(
      {
        ok: false,
        rateLimited: true,
        message:
          'This property has reached its daily verification limit. Please try again tomorrow.',
      },
      { status: 429 },
    );
  }
  return Response.json(result);
};
```

- [ ] **Step 5: Run the new test + the existing verification suite**

Run: `npx vitest run --config vitest.workers.config.ts test/server/verify-request-ratelimit.test.ts test/server/verification.test.ts`
Expected: PASS. (The direct-call `verification.test.ts` uses `requestPropertyVerification` and never trips the property cap in its single-call cases; the new `rateLimited` union member is additive.)

- [ ] **Step 6: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/server/verification/property.ts src/pages/api/verify/request.ts test/server/verify-request-ratelimit.test.ts
git commit -m "$(cat <<'EOF'
feat(verification): enforce rate limits on /api/verify/request (#1)

Per-user cooldown + daily cap checked before any send; per-property daily
cap checked once the address resolves. Returns 429 with a friendly JSON
message. Prevents burning Twilio credit / harassing residents.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: Surface the 429 in the verification form

**Files:**

- Modify: `src/components/react/AuthForms.tsx` (`VerifyPropertyForm.request`)
- Test: `test/unit/verify-form-ratelimit.test.tsx` (create)

**Interfaces:**

- Consumes: the 429 JSON `{ rateLimited, message }` from B2.

- [ ] **Step 1: Write the failing test**

Create `test/unit/verify-form-ratelimit.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifyPropertyForm } from '../../src/components/react/AuthForms';

afterEach(() => vi.restoreAllMocks());

describe('VerifyPropertyForm rate-limit message', () => {
  it('shows the server message on a 429', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          rateLimited: true,
          message: 'Please wait a couple of minutes.',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(<VerifyPropertyForm />);
    fireEvent.change(screen.getByPlaceholderText(/property address/i), {
      target: { value: '1 Test St' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/please wait a couple of minutes/i),
      ).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/verify-form-ratelimit.test.tsx`
Expected: FAIL — the form currently ignores status 429 and would show the generic "Could not start verification" text.

- [ ] **Step 3: Handle 429 in `VerifyPropertyForm.request`**

In `src/components/react/AuthForms.tsx`, inside `request`, replace the block from `const data = (await res.json())...` through the final `else` with:

```ts
const data = (await res.json()) as {
  ok?: boolean;
  queued?: boolean;
  rateLimited?: boolean;
  message?: string;
};
if (res.status === 429 || data.rateLimited) {
  setMsg(data.message ?? 'Too many requests. Please wait and try again.');
  return;
}
if (data.queued)
  setMsg(
    "Sent for manual review — you'll get a confirmation once your account is approved.",
  );
else if (data.ok) {
  setMsg('Code sent — check your phone/email.');
  setStage('confirm');
} else setMsg('Could not start verification. Check the address and try again.');
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/unit/verify-form-ratelimit.test.tsx`
Expected: PASS.

- [ ] **Step 5: Format & commit**

```bash
npm run check
npm run format
git add src/components/react/AuthForms.tsx test/unit/verify-form-ratelimit.test.tsx
git commit -m "$(cat <<'EOF'
feat(verification): show the rate-limit message in the verify form (#1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> PR B complete. Gate: `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.

---

## PR C — Document upload/download constraints (#2)

Branch: `git checkout main && git checkout -b feat/document-type-constraints`

### Task C1: Upload allowlist + canonical content type

**Files:**

- Modify: `src/pages/api/admin/documents.ts` (`POST`)
- Test: `test/server/admin-documents-board.test.ts` (extend)

**Interfaces:**

- Produces: uploads restricted to an extension allowlist; stored `contentType` derived server-side (client MIME ignored).

- [ ] **Step 1: Add failing tests to the board upload suite**

Append two tests inside the `describe('admin documents — board', …)` block in `test/server/admin-documents-board.test.ts`:

```ts
it('rejects a disallowed extension with 415', async () => {
  const form = new FormData();
  form.set('file', new File(['x'], 'evil.html', { type: 'text/html' }));
  form.set('title', 'Evil');
  form.set('category', 'Other');
  form.set('visibility', 'public');
  const res = await POST({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'POST',
      body: form,
    }),
  } as never);
  expect(res.status).toBe(415);
});

it('stores a server-derived content type, ignoring the client MIME', async () => {
  const form = new FormData();
  // Wrong/empty client MIME on a .csv — server should canonicalize to text/csv.
  form.set(
    'file',
    new File(['a,b'], 'roster.csv', { type: 'application/octet-stream' }),
  );
  form.set('title', 'Roster CSV');
  form.set('category', 'Other');
  form.set('visibility', 'public');
  const res = await POST({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'POST',
      body: form,
    }),
  } as never);
  expect(res.status).toBe(201);
  const [row] = await getDb(env)
    .select()
    .from(documents)
    .where(eq(documents.title, 'Roster CSV'));
  expect(row.contentType).toBe('text/csv');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-documents-board.test.ts`
Expected: FAIL — `.html` currently uploads (no 415); `.csv` stores `application/octet-stream`.

- [ ] **Step 3: Add the allowlist to `documents.ts` POST**

In `src/pages/api/admin/documents.ts`, add near the top (after the existing `const VISIBILITIES = ...`):

```ts
// Server-side allowlist keyed by extension. Client MIME is unreliable for
// .md/.csv, so derive the stored content type here. text/html and image/svg+xml
// are deliberately excluded — they are the stored-XSS vectors when served inline.
const EXT_TO_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
```

Inside `POST`, after the `if (file.size > MAX_BYTES) ...` line, add the type check:

```ts
const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
const contentType = EXT_TO_TYPE[ext];
if (!contentType) return new Response('Unsupported file type', { status: 415 });
```

Then replace the two `file.type` usages:

- `httpMetadata: { contentType: file.type },` → `httpMetadata: { contentType },`
- `contentType: file.type || 'application/octet-stream',` → `contentType,`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-documents-board.test.ts`
Expected: PASS (existing PDF upload test still passes — `.pdf` maps to `application/pdf`).

- [ ] **Step 5: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/pages/api/admin/documents.ts test/server/admin-documents-board.test.ts
git commit -m "$(cat <<'EOF'
fix(documents): server-side upload type allowlist (#2)

Validate by extension (pdf/txt/md/csv/doc/docx/xls/xlsx) and store a
canonical, server-derived content type instead of the client MIME. Blocks
text/html and other active types from being uploaded.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task C2: Safe download disposition + filename sanitization

**Files:**

- Modify: `src/pages/api/files/[id].ts` (`GET`)
- Test: `test/server/files-download-safety.test.ts` (create)

**Interfaces:**

- Produces: `nosniff` on every download; `inline` only for `application/pdf`, `attachment` otherwise; control chars stripped from the filename header.

- [ ] **Step 1: Write the failing test**

Create `test/server/files-download-safety.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/files/[id]';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function seed(id: string, contentType: string, filename: string) {
  const now = new Date();
  const r2Key = `documents/${id}/file`;
  await env.DOCS.put(r2Key, 'bytes');
  await getDb(env).insert(documents).values({
    id,
    title: id,
    category: 'Other',
    visibility: 'public', // public: skips auth so the test stays focused on headers
    r2Key,
    filename,
    sizeBytes: 5,
    contentType,
    uploadedAt: now,
    updatedAt: now,
  });
}

function get(id: string) {
  return GET({
    params: { id },
    request: new Request(`http://localhost/api/files/${id}`),
  } as never);
}

describe('file download safety', () => {
  it('serves non-PDF as an attachment with nosniff', async () => {
    await seed('dl-html', 'text/html', 'page.html');
    const res = await get('dl-html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('serves PDF inline with nosniff', async () => {
    await seed('dl-pdf', 'application/pdf', 'doc.pdf');
    const res = await get('dl-pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
  });

  it('strips control characters from the filename header', async () => {
    await seed('dl-ctrl', 'application/pdf', 'a\r\nb"c.pdf');
    const res = await get('dl-ctrl');
    const cd = res.headers.get('content-disposition')!;
    expect(cd).not.toMatch(/[\r\n"]/);
    expect(cd).toContain('abc.pdf');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts test/server/files-download-safety.test.ts`
Expected: FAIL — today the handler sets no `nosniff` and always uses `inline`.

- [ ] **Step 3: Harden the download headers in `files/[id].ts`**

In `src/pages/api/files/[id].ts`, replace the header-building block (from `const headers = new Headers();` through the `cache-control` set) with:

```ts
const headers = new Headers();
headers.set('content-type', doc.contentType);
headers.set('x-content-type-options', 'nosniff');
// Strip control chars and quotes/backslashes so the filename can't break the
// header or inject a second directive.
const safeName = [...doc.filename]
  .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '"' && ch !== '\\')
  .join('');
const disposition =
  doc.contentType === 'application/pdf' ? 'inline' : 'attachment';
headers.set('content-disposition', `${disposition}; filename="${safeName}"`);
headers.set(
  'cache-control',
  doc.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store',
);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/files-download-safety.test.ts test/server/files.test.ts test/server/files-authz.test.ts`
Expected: PASS (auth/tier gating in the existing files tests unchanged).

- [ ] **Step 5: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/pages/api/files/[id].ts test/server/files-download-safety.test.ts
git commit -m "$(cat <<'EOF'
fix(files): nosniff + attachment for non-PDF downloads (#2)

Always send X-Content-Type-Options: nosniff; serve inline only for PDFs
and force attachment for everything else; strip control chars from the
Content-Disposition filename. Neutralizes stored-XSS via uploaded docs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> PR C complete. Gate: `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.

---

## PR D — Board handoff + role-surface tightening (#5)

Branch: `git checkout main && git checkout -b feat/board-handoff`

**Task order matters:** D1 and D2 remove all `auth.api.setRole` calls (moving to direct DB writes). Only then does D3 remove board's admin-plugin capabilities — otherwise the setRole calls would start failing.

### Task D1: `roles.ts` → direct DB promote/demote + board list

**Files:**

- Modify: `src/pages/api/admin/roles.ts` (full rewrite)
- Test: `test/server/admin-roles-board.test.ts` (create); `test/server/admin-roles.test.ts` (unchanged — its 401 checks still hold)

**Interfaces:**

- Produces:
  - `GET /api/admin/roles` → `{ board: { id, name, email, createdAt }[] }`
  - `POST /api/admin/roles` body `{ action: 'promote', email }` (204 / 404) or `{ action: 'demote', userId }` (204 / 409 when it's the last board member).

- [ ] **Step 1: Write the failing board test**

Create `test/server/admin-roles-board.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET, POST } from '../../src/pages/api/admin/roles';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function mkUser(id: string, email: string, role: string) {
  const now = new Date();
  await getDb(env).insert(users).values({
    id,
    name: id,
    email,
    emailVerified: true,
    role,
    createdAt: now,
    updatedAt: now,
  });
}

function post(body: unknown) {
  return POST({
    request: new Request('http://localhost/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

// vitest-pool-workers isolates storage per test (writes inside an `it` are
// rolled back; only beforeAll writes persist), so each test seeds its own users
// and starts from an empty users table. Do NOT rely on state from a prior `it`.
describe('admin roles — board handoff', () => {
  it('promotes an existing account to board by email', async () => {
    await mkUser('rd-home', 'incoming@example.com', 'homeowner');
    const res = await post({
      action: 'promote',
      email: 'incoming@example.com',
    });
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-home'));
    expect(u.role).toBe('board');
  });

  it('404s promoting an unknown email', async () => {
    const res = await post({ action: 'promote', email: 'nobody@example.com' });
    expect(res.status).toBe(404);
  });

  it('lists current board members', async () => {
    await mkUser('rd-list', 'listed@example.com', 'board');
    const res = await GET({
      request: new Request('http://localhost/api/admin/roles'),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { board: { email: string }[] };
    expect(body.board.some((m) => m.email === 'listed@example.com')).toBe(true);
  });

  it('demotes a board member when others remain', async () => {
    await mkUser('rd-a', 'a@example.com', 'board');
    await mkUser('rd-b', 'b@example.com', 'board');
    const res = await post({ action: 'demote', userId: 'rd-b' });
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-b'));
    expect(u.role).toBe('visitor');
  });

  it('refuses to demote the last board member (409)', async () => {
    await mkUser('rd-solo', 'solo@example.com', 'board');
    const res = await post({ action: 'demote', userId: 'rd-solo' });
    expect(res.status).toBe(409);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'rd-solo'));
    expect(u.role).toBe('board');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-roles-board.test.ts`
Expected: FAIL — current `roles.ts` has no `GET`, and `POST` expects `{ userId, role, action }` semantics via Better Auth `setRole`.

- [ ] **Step 3: Rewrite `src/pages/api/admin/roles.ts`**

```ts
import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { users } from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const board = await getDb(env)
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, 'board'));
  return Response.json({ board });
};

// Board handoff is a deliberate, supported workflow: an outgoing board member
// promotes the incoming one, then the incoming one demotes the outgoing one.
// Role changes are direct DB writes (getAuthContext re-reads role every request,
// so they take effect immediately) — no dependency on the Better Auth admin API.
export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    email?: string;
    userId?: string;
  } | null;
  if (!body) return new Response('Bad Request', { status: 400 });
  const db = getDb(env);

  if (body.action === 'promote') {
    const email = body.email?.trim();
    if (!email) return new Response('Email required', { status: 400 });
    const [target] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    if (!target)
      return new Response('No account with that email', { status: 404 });
    await db
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, target.id));
    return new Response(null, { status: 204 });
  }

  if (body.action === 'demote') {
    if (!body.userId) return new Response('userId required', { status: 400 });
    const board = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'board'));
    if (board.length <= 1)
      return new Response('Cannot demote the last board member', {
        status: 409,
      });
    await db
      .update(users)
      .set({ role: 'visitor' })
      .where(and(eq(users.id, body.userId), eq(users.role, 'board')));
    return new Response(null, { status: 204 });
  }

  return new Response('Bad action', { status: 400 });
};
```

- [ ] **Step 4: Run board + legacy roles tests**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-roles-board.test.ts test/server/admin-roles.test.ts`
Expected: PASS (`admin-roles.test.ts` only asserts 401 for unauth, returned before body parsing — still true).

- [ ] **Step 5: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/pages/api/admin/roles.ts test/server/admin-roles-board.test.ts
git commit -m "$(cat <<'EOF'
feat(roles): board handoff via direct-DB promote/demote (#5)

GET lists board members; POST promotes an account to board by email and
demotes a board member by id, refusing to demote the last remaining board
member. Direct DB writes, no Better Auth admin API.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task D2: `members.ts` revoke → direct DB + refuse board demotion

**Files:**

- Modify: `src/pages/api/admin/members.ts` (revoke branch; drop `createAuth` import)
- Test: `test/server/admin-members-revoke.test.ts` (create)

**Interfaces:**

- Produces: `POST /api/admin/members {action:'revoke', userId}` → 204 for a homeowner (role→visitor, links deleted); 409 if the target is a board member.

- [ ] **Step 1: Write the failing test**

Create `test/server/admin-members-revoke.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST } from '../../src/pages/api/admin/members';
import { getDb } from '../../src/server/db/client';
import { users, userPropertyLinks } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function mkUser(id: string, role: string) {
  const now = new Date();
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      role,
      createdAt: now,
      updatedAt: now,
    });
}

function revoke(userId: string) {
  return POST({
    request: new Request('http://localhost/api/admin/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'revoke', userId }),
    }),
  } as never);
}

describe('members revoke', () => {
  it('revokes a homeowner to visitor and deletes their links', async () => {
    await mkUser('mr-home', 'homeowner');
    await getDb(env).insert(userPropertyLinks).values({
      id: 'link-1',
      userId: 'mr-home',
      propertyId: 'p',
      verifiedAt: new Date(),
      method: 'otp_email',
    });
    const res = await revoke('mr-home');
    expect(res.status).toBe(204);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'mr-home'));
    expect(u.role).toBe('visitor');
    const links = await getDb(env)
      .select()
      .from(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, 'mr-home'));
    expect(links).toHaveLength(0);
  });

  it('refuses to demote a board member here (409)', async () => {
    await mkUser('mr-board', 'board');
    const res = await revoke('mr-board');
    expect(res.status).toBe(409);
    const [u] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'mr-board'));
    expect(u.role).toBe('board');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-members-revoke.test.ts`
Expected: FAIL — current revoke calls `setRole` (which, without a real board session, won't behave as the test expects) and does not refuse board targets.

- [ ] **Step 3: Rewrite the revoke branch in `members.ts`**

In `src/pages/api/admin/members.ts`:

- Remove the import `import { createAuth } from '../../../server/auth';` (revoke was its only user; approve uses direct DB).
- Ensure `users` and `userPropertyLinks` are imported (they already are; `and`/`eq` too).
- Replace the whole `if (body.action === 'revoke') { ... }` block with:

```ts
  if (body.action === 'revoke') {
    if (!body.userId) return new Response('Bad Request', { status: 400 });
    const [target] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, body.userId));
    if (target?.role === 'board')
      return new Response(
        'Cannot demote a board member here; use Board members.',
        { status: 409 },
      );
    await db.update(users).set({ role: 'visitor' }).where(eq(users.id, body.userId));
    await db
      .delete(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, body.userId));
  } else if (body.action === 'approve') {
```

(Keep the `approve` and `deny` branches exactly as they are.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-members-revoke.test.ts test/server/admin-members.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/pages/api/admin/members.ts test/server/admin-members-revoke.test.ts
git commit -m "$(cat <<'EOF'
fix(members): revoke via direct DB write; refuse board demotion (#5)

The homeowner Members panel no longer demotes board members (409 → use
Board members). Revoke is now a direct users.role write + link cleanup,
dropping the Better Auth admin API dependency.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task D3: Close impersonation/ban on board sessions

**Files:**

- Modify: `src/server/auth/permissions.ts` (drop `...adminAc.statements` from `board`)
- Test: `test/unit/permissions.test.ts` (update)

**Background (verified via Better Auth docs):** this app uses **custom access control** (`ac` + `roles: { visitor, homeowner, board }`). With custom AC, capabilities flow from each role's statements, not from `adminRoles`. Today `board` spreads `...adminAc.statements`, which includes `user: ['set-role','ban','impersonate','delete',…]`. Since D1/D2 removed every `auth.api.setRole` call, board needs none of these. Removing the spread denies `/api/auth/admin/*` (impersonate/ban/set-role) to board sessions. `isAdmin` is derived from the `role` column client-side, so the admin UI gate is unaffected. Leave `adminRoles: ['board']` and the admin plugin install as-is (needed for the `role`/`banned` schema and `defaultRole`).

- [ ] **Step 1: Update the permissions unit test**

Replace `test/unit/permissions.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { board, homeowner, visitor } from '../../src/server/auth/permissions';

describe('board role permissions', () => {
  it('board no longer holds admin-plugin capabilities', () => {
    expect(board.authorize({ user: ['set-role'] }).success).toBe(false);
    expect(board.authorize({ user: ['ban'] }).success).toBe(false);
    expect(board.authorize({ user: ['impersonate'] }).success).toBe(false);
  });
  it('non-board roles hold none either', () => {
    expect(homeowner.authorize({ user: ['set-role'] }).success).toBe(false);
    expect(visitor.authorize({ user: ['set-role'] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/permissions.test.ts`
Expected: FAIL — board currently authorizes `set-role`/`ban`/`impersonate` (true).

- [ ] **Step 3: Trim the `board` role in `permissions.ts`**

In `src/server/auth/permissions.ts`, change the `board` role definition from:

```ts
export const board = ac.newRole({
  ...adminAc.statements,
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
});
```

to:

```ts
// Board holds no Better Auth admin-plugin capabilities: all role changes are
// direct DB writes (see api/admin/roles.ts, members.ts), so impersonation/ban/
// set-role are intentionally NOT granted. The custom statements below document
// intent; enforcement of board-only routes is rank-based in requireBoard.
export const board = ac.newRole({
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
});
```

Then remove the now-unused `adminAc` import: change
`import { defaultStatements, adminAc } from 'better-auth/plugins/admin/access';`
to
`import { defaultStatements } from 'better-auth/plugins/admin/access';`

(Keep `...defaultStatements` in the `statement` object — that defines the available actions the roles are scoped against; only the `board` role's _grant_ of the admin actions is removed.)

- [ ] **Step 4: Run permissions + auth-handler tests to verify pass**

Run: `npx vitest run test/unit/permissions.test.ts`
Expected: PASS.
Run: `npx vitest run --config vitest.workers.config.ts test/server/auth-handler.test.ts`
Expected: PASS (sign-in/session behavior unchanged — the plugin is still installed).

- [ ] **Step 5: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/server/auth/permissions.ts test/unit/permissions.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): remove impersonation/ban/set-role from the board role (#5)

With custom access control, capabilities flow from role statements. Board
no longer spreads adminAc.statements, so /api/auth/admin/* (impersonate,
ban, set-role) is denied to board sessions. Role changes are direct DB
writes, so nothing in-app needed those capabilities.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task D4: Board-members admin UI

**Files:**

- Modify: `src/lib/admin.ts` (add helpers), `src/lib/types.ts` (reuse `MemberUser`)
- Create: `src/components/admin/BoardMembersManager.tsx`
- Modify: `src/components/admin/AdminApp.tsx` (add section)
- Test: `src/components/admin/BoardMembersManager.test.tsx` (create)

**Interfaces:**

- Consumes: `GET/POST /api/admin/roles` from D1.
- Produces: `fetchBoardMembers(): Promise<MemberUser[]>`, `promoteToBoard(email: string): Promise<void>`, `demoteFromBoard(userId: string): Promise<void>`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/admin/BoardMembersManager.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchBoardMembers = vi.fn();
const promoteToBoard = vi.fn().mockResolvedValue(undefined);
const demoteFromBoard = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchBoardMembers: (...a: unknown[]) => fetchBoardMembers(...a),
  promoteToBoard: (...a: unknown[]) => promoteToBoard(...a),
  demoteFromBoard: (...a: unknown[]) => demoteFromBoard(...a),
}));

import BoardMembersManager from './BoardMembersManager';

describe('BoardMembersManager', () => {
  beforeEach(() => {
    fetchBoardMembers
      .mockReset()
      .mockResolvedValue([
        {
          id: 'u1',
          name: 'Alice',
          email: 'alice@example.com',
          createdAt: '2026-01-01',
        },
      ]);
    promoteToBoard.mockClear();
    demoteFromBoard.mockClear();
  });

  it('lists board members and promotes by email', async () => {
    render(<BoardMembersManager />);
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/person@example.com/i), {
      target: { value: 'bob@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /promote to board/i }));
    await waitFor(() =>
      expect(promoteToBoard).toHaveBeenCalledWith('bob@example.com'),
    );
  });

  it('demotes a board member', async () => {
    render(<BoardMembersManager />);
    fireEvent.click(await screen.findByRole('button', { name: /demote/i }));
    await waitFor(() => expect(demoteFromBoard).toHaveBeenCalledWith('u1'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/admin/BoardMembersManager.test.tsx`
Expected: FAIL — component + helpers don't exist.

- [ ] **Step 3: Add the helpers to `src/lib/admin.ts`**

Append (and add `MemberUser` to the type import at the top of the file):

```ts
// ---------- Board membership (handoff) ----------
export async function fetchBoardMembers(): Promise<MemberUser[]> {
  const res = await fetch('/api/admin/roles');
  if (!res.ok) throw new Error(`Load board failed: ${res.status}`);
  const data = (await res.json()) as { board: MemberUser[] };
  return data.board;
}

export async function promoteToBoard(email: string): Promise<void> {
  const res = await fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'promote', email }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Promote failed: ${res.status}`);
}

export async function demoteFromBoard(userId: string): Promise<void> {
  const res = await fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'demote', userId }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Demote failed: ${res.status}`);
}
```

At the top of `src/lib/admin.ts`, add `MemberUser` to the existing type import:

```ts
import type {
  Announcement,
  DuesSettings,
  SiteSettings,
  PropertyWithOwners,
  MembersView,
  MemberUser,
} from './types';
```

- [ ] **Step 4: Create `src/components/admin/BoardMembersManager.tsx`**

```tsx
import { useEffect, useState } from 'react';
import {
  fetchBoardMembers,
  promoteToBoard,
  demoteFromBoard,
} from '../../lib/admin';
import type { MemberUser } from '../../lib/types';

export default function BoardMembersManager() {
  const [board, setBoard] = useState<MemberUser[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    setBoard(await fetchBoardMembers());
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function promote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      await promoteToBoard(email.trim());
      setEmail('');
      setMsg('Promoted to board.');
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not promote.'));
    } finally {
      setBusy(false);
    }
  }

  async function demote(u: MemberUser) {
    setMsg('');
    try {
      await demoteFromBoard(u.id);
      setMsg('Board member demoted.');
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not demote.'));
    }
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Board members</h1>
      </div>
      <p className="admin-panel__intro">
        Promote an existing account to the board or demote a board member. For a
        handoff, the outgoing member promotes the incoming one, then the
        incoming member demotes the outgoing one. The last remaining board
        member can't be demoted.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <form
        className="panel-card"
        style={{ maxWidth: '620px', marginBottom: '18px' }}
        onSubmit={promote}
      >
        <div className="field">
          <label>Promote account by email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            required
          />
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Promoting…' : 'Promote to board'}
          </button>
        </div>
      </form>

      <div className="panel-editor__title">Current board</div>
      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : board.length === 0 ? (
          <p className="muted panel-pad">No board members.</p>
        ) : (
          board.map((u) => (
            <div key={u.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{u.name}</div>
                <div className="admin-row-sub">{u.email}</div>
              </div>
              <div className="row-actions">
                <button
                  className="row-link row-link--danger"
                  onClick={() => demote(u)}
                >
                  Demote
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire it into `AdminApp.tsx`**

In `src/components/admin/AdminApp.tsx`:

- Add the import (next to the other manager imports):
  ```ts
  import BoardMembersManager from './BoardMembersManager';
  ```
- Add a section to `SECTIONS`, immediately after the `members` entry:

  ```ts
  { key: 'board', label: 'Board members', render: () => <BoardMembersManager /> },
  ```

- [ ] **Step 6: Run component + admin app tests to verify pass**

Run: `npx vitest run src/components/admin/BoardMembersManager.test.tsx src/components/admin/AdminApp.test.tsx`
Expected: PASS.

- [ ] **Step 7: Type-check, format, commit**

```bash
npm run check
npm run format
git add src/lib/admin.ts src/components/admin/BoardMembersManager.tsx src/components/admin/BoardMembersManager.test.tsx src/components/admin/AdminApp.tsx
git commit -m "$(cat <<'EOF'
feat(admin): Board members panel for handoff (#5)

List/promote(by email)/demote board members from /admin. Promotion and
demotion call the roles endpoint; the last-board-member guard is enforced
server-side.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task D5: Align the docs

**Files:**

- Modify: `README.md`, `CLAUDE.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the "self-grantable" claims**

Find the sentence in `README.md` and in `CLAUDE.md` stating board is "never self-grantable through the app" (in `CLAUDE.md` it reads: "`board` is never self-grantable through the app"). Replace with an accurate description, e.g.:

> Board membership is managed in the admin app under **Board members**: a board
> member can promote another account to `board` and demote a board member
> (the last remaining board member can't be demoted). This supports board
> handoff. A board member cannot escalate their own access beyond `board`, and
> the _first_ board account is still bootstrapped out-of-band via
> `scripts/seed-board.ts`. The Better Auth admin plugin's impersonation/ban/
> set-role endpoints are not granted to board sessions.

- [ ] **Step 2: Verify the docs don't reference the old roles contract**

Run: `git grep -n "self-grantable" README.md CLAUDE.md`
Expected: no matches remain (or only the corrected wording).
Run: `git grep -n "roles" CLAUDE.md`
Expected: any `/api/admin/roles` description matches the new promote/demote-by-email contract; update if stale.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: describe board handoff and closed admin surface (#5)

Board can promote/demote board through the admin app (handoff); correct
the "never self-grantable" wording; note impersonation/ban are closed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

> PR D complete. Gate: `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.

---

## Self-Review

**Spec coverage:**

- #1 rate limit → Tasks B1–B3 ✓
- #2 upload/download → Tasks C1 (upload allowlist, expanded types), C2 (download safety) ✓; Drive import documented as non-goal in the spec ✓
- #3 headers → Task A3 ✓ (CSP Report-Only + HSTS SETUP.md note)
- #4 OTP HMAC + constant-time → Task A1 ✓
- #5 board handoff + close impersonation + docs → Tasks D1–D5 ✓ (roles direct-DB, members refuse-board, permissions trim, Board-members UI, docs)
- #6 settings validation → Task A2 ✓ (site+dues write, dues read, url scheme check)

**Placeholder scan:** No TBD/TODO; every code and test step contains full content. The one external-behavior claim (adminRoles vs AC) is resolved in D3's background note from the Better Auth docs and asserted by the permissions test.

**Type consistency:**

- `hashCode`/`verifyCode` gain a `secret` param everywhere they're called (A1 covers `codes.ts`, `property.ts`, both test files).
- `requestPropertyVerification` return type extended to include `{ ok:false; rateLimited:true }` (B2), and `request.ts` narrows with `'rateLimited' in result`.
- `fetchBoardMembers`/`promoteToBoard`/`demoteFromBoard` names match between `lib/admin.ts` (D4 step 3) and the component/test (D4 steps 1, 4).
- Roles endpoint contract (`{action:'promote', email}` / `{action:'demote', userId}` / `GET → {board}`) is identical across D1 (handler), D4 (helpers), and both tests.

**Sequencing check:** D3 (remove board admin capabilities) is placed _after_ D1+D2 (which remove the `setRole` calls), so no in-app call loses its permission mid-flight. ✓

## Notes for the executor

- **CSP flip is deliberately out of this plan.** A3 ships Report-Only. Flipping to enforced (once the browser console shows no legitimate violations) is a small follow-up noted in `SETUP.md`; do not enforce blindly.
- **Demotion target is `visitor`** (matches the prior revoke semantics). If a demoted board member is still a resident, they re-verify their property to regain homeowner — acceptable for now; revisit if it annoys operators.
- **KV counter races** are acknowledged in `rate-limit.ts`; the cooldown covers bursts. Fine at HOA scale.
- Each PR ends with the full local gate: `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.
