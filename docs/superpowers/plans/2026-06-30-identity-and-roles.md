# Identity & Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add homeowner/board accounts with possession-based property verification and server-enforced role authorization, on a Cloudflare Workers + D1 + Better Auth stack, replacing the current Firebase Auth board login.

**Architecture:** The existing Astro site moves to the Cloudflare adapter so `src/pages/api/*` routes run as Workers with a D1 binding (`locals.runtime.env.DATABASE`). Better Auth (wrapped by `better-auth-cloudflare`) handles accounts, sessions, email verification, and roles, persisting to D1 via Drizzle. A **custom** property-verification flow sends a one-time code to the contact already on file in the imported owner roster and, on success, links the account to that owner record and grants the homeowner role. All authorization is re-checked server-side per request.

**Tech Stack:** Astro + `@astrojs/cloudflare`, Cloudflare Workers, D1 (SQLite), Better Auth + `better-auth-cloudflare` + `admin` plugin, Drizzle ORM + drizzle-kit, Vitest + `@cloudflare/vitest-pool-workers`, Cloudflare Turnstile, an email sender, and Twilio for SMS.

## Global Constraints

- Node `>=26.4.0` (from `package.json` `engines`); run `nvm use` (`.nvmrc` = `26.4.0`).
- The `board` role is NEVER grantable by any self-service path — only by an existing board member via the admin API, plus one seeded bootstrap account.
- All authorization is enforced in Worker code, never the client; every protected endpoint re-resolves session → role → property links and applies the rule before returning data.
- Per-owner private data is readable only by `board` or by a `homeowner` whose `user_property_links` include that `owner_id`.
- One-time property-verification codes: single-use, hashed at rest, 10-minute expiry, max 5 attempts then lockout.
- Secrets (Twilio, email provider, Turnstile secret, `BETTER_AUTH_SECRET`) live in Wrangler secrets / `.dev.vars`, never committed. `private/` and `.dev.vars` stay gitignored.
- Tests use Vitest (already the repo's runner); Worker/D1 tests use `@cloudflare/vitest-pool-workers`.
- Commit after every task. Work on a feature branch, not `main`.

---

## File Structure

```
wrangler.toml                         # Cloudflare Worker + D1 + KV bindings
drizzle.config.ts                     # drizzle-kit config (D1 dialect)
.dev.vars                             # local secrets (gitignored)
worker-configuration.d.ts             # generated CF binding types

src/
  server/
    db/
      schema.ts                       # Drizzle schema: auth tables (generated) + app tables
      client.ts                       # drizzle(env.DATABASE) factory
      migrations/                     # drizzle-kit generated SQL migrations
    auth/
      index.ts                        # createAuth(env) factory + static `auth` export for CLI
      permissions.ts                  # access controller + visitor/homeowner/board roles
      senders.ts                      # sendEmail() + sendSms() abstractions
    authz/
      context.ts                      # getAuthContext(request, env) -> { user, role, ownerIds }
      guards.ts                       # requireRole / requireOwnerAccess helpers
    verification/
      codes.ts                        # generate/hash/verify one-time codes + attempt limiting
      property.ts                     # requestPropertyVerification / confirmPropertyVerification
    roster/
      lookup.ts                       # find owner by address (normalized)

  pages/
    api/
      auth/[...all].ts                # mounts Better Auth handler
      verify/request.ts              # POST: start property verification
      verify/confirm.ts              # POST: complete property verification
      admin/owners.ts                # GET/POST/PATCH roster (board only)
      admin/members.ts               # GET/POST homeowner review, revoke, queue (board only)
      admin/roles.ts                 # POST grant/revoke board role (board only)

  lib/
    auth-client.ts                    # Better Auth browser client

scripts/
  import-roster.ts                    # parse contact list xlsx -> owners table
  seed-board.ts                       # create the first board account

test/
  server/                             # Worker/D1 integration tests (vitest-pool-workers)
  unit/                               # pure-logic unit tests (codes, authz rules, roster lookup)
```

---

## Task 1: Cloudflare + Wrangler + D1 scaffolding

**Files:**

- Create: `wrangler.toml`, `.dev.vars`, `.dev.vars.example`
- Modify: `package.json` (deps + scripts), `astro.config.mjs`, `.gitignore`

**Interfaces:**

- Produces: a deployable Astro-on-Cloudflare app with a `DATABASE` (D1) and `KV` binding reachable in API routes via `locals.runtime.env`.

- [ ] **Step 1: Install dependencies**

```bash
npm install @astrojs/cloudflare better-auth better-auth-cloudflare drizzle-orm
npm install -D wrangler drizzle-kit @cloudflare/workers-types @cloudflare/vitest-pool-workers
```

- [ ] **Step 2: Switch Astro to the Cloudflare adapter**

Edit `astro.config.mjs`:

```js
// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://valleys-ashebrook.web.app',
  output: 'server',
  adapter: cloudflare({ platformProxy: { enabled: true } }),
  integrations: [react()],
});
```

- [ ] **Step 3: Create `wrangler.toml`**

```toml
name = "valleys-at-ashebrook-hoa"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "dist"

[[d1_databases]]
binding = "DATABASE"
database_name = "ashebrook-hoa"
database_id = "PLACEHOLDER_RUN_D1_CREATE"  # replace with output of `wrangler d1 create`

[[kv_namespaces]]
binding = "KV"
id = "PLACEHOLDER_RUN_KV_CREATE"           # replace with output of `wrangler kv namespace create`
```

- [ ] **Step 4: Create the D1 database and KV namespace, paste the IDs**

```bash
npx wrangler d1 create ashebrook-hoa
npx wrangler kv namespace create KV
```

Paste the printed `database_id` and KV `id` into `wrangler.toml`.

- [ ] **Step 5: Create local secrets files**

`.dev.vars.example` (committed):

```
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:4321
EMAIL_API_KEY=
EMAIL_FROM=board@example.com
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
TURNSTILE_SECRET_KEY=
```

Copy to `.dev.vars` (gitignored) and fill `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.

- [ ] **Step 6: Gitignore the secrets and generated types**

Add to `.gitignore`:

```
# cloudflare
.dev.vars
.wrangler/
worker-configuration.d.ts
```

- [ ] **Step 7: Add scripts to `package.json`**

```json
"cf:types": "wrangler types",
"db:generate": "drizzle-kit generate",
"db:migrate:local": "wrangler d1 migrations apply ashebrook-hoa --local",
"db:migrate:remote": "wrangler d1 migrations apply ashebrook-hoa --remote",
"auth:generate": "npx @better-auth/cli generate --output src/server/db/auth-schema.ts"
```

- [ ] **Step 8: Generate binding types and verify the build**

```bash
npm run cf:types
npm run build
```

Expected: `wrangler types` writes `worker-configuration.d.ts`; `astro build` completes with the Cloudflare adapter (no SSR errors).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: add Cloudflare adapter, Wrangler, D1, and KV scaffolding"
```

---

## Task 2: Drizzle schema (auth + app tables) and D1 migrations

**Files:**

- Create: `drizzle.config.ts`, `src/server/db/schema.ts`, `src/server/db/client.ts`
- Generated: `src/server/db/auth-schema.ts`, `src/server/db/migrations/*`

**Interfaces:**

- Produces: Drizzle tables `owners`, `userPropertyLinks`, `propertyVerifications`, `manualApprovalQueue` (plus Better-Auth-generated `users`/`sessions`/`accounts`/`verifications`), and `getDb(env)` returning a Drizzle client.

- [ ] **Step 1: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
});
```

- [ ] **Step 2: Create the D1 client factory `src/server/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getDb(env: Env) {
  return drizzle(env.DATABASE, { schema });
}

export type Db = ReturnType<typeof getDb>;
```

- [ ] **Step 3: Generate the Better Auth schema (auth tables + admin plugin fields)**

First create the auth config stub so the CLI can read plugins (full config comes in Task 3); for now a minimal static export:

```ts
// src/server/auth/index.ts (temporary minimal version for CLI; expanded in Task 3)
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';

export const auth = betterAuth({
  emailAndPassword: { enabled: true },
  plugins: [admin()],
});
```

Then:

```bash
npm run auth:generate
```

Expected: `src/server/db/auth-schema.ts` is written with `users`, `sessions`, `accounts`, `verifications` (the `admin` plugin adds `role` and `banned` columns to `users`).

- [ ] **Step 4: Write the app schema `src/server/db/schema.ts`**

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Re-export the Better-Auth-generated tables so one schema covers everything.
export * from './auth-schema';

export const owners = sqliteTable('owners', {
  id: text('id').primaryKey(),
  fullName: text('full_name').notNull(),
  address: text('address').notNull(),
  addressNormalized: text('address_normalized').notNull(),
  unit: text('unit'),
  phone: text('phone'),
  email: text('email'),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const userPropertyLinks = sqliteTable('user_property_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  ownerId: text('owner_id').notNull(),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }).notNull(),
  method: text('method', {
    enum: ['otp_email', 'otp_sms', 'board_manual'],
  }).notNull(),
});

export const propertyVerifications = sqliteTable('property_verifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  ownerId: text('owner_id').notNull(),
  channel: text('channel', { enum: ['email', 'sms'] }).notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: integer('consumed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const manualApprovalQueue = sqliteTable('manual_approval_queue', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  claimedAddress: text('claimed_address').notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 5: Generate and apply migrations locally**

```bash
npm run db:generate
npm run db:migrate:local
```

Expected: a SQL migration file appears under `src/server/db/migrations/`; applying it to the local D1 succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Drizzle schema for auth and roster tables with D1 migrations"
```

---

## Task 3: Better Auth configuration (Cloudflare + roles + email verification)

**Files:**

- Modify: `src/server/auth/index.ts`
- Create: `src/server/auth/permissions.ts`, `src/lib/auth-client.ts`, `src/pages/api/auth/[...all].ts`
- Test: `test/server/auth-handler.test.ts`

**Interfaces:**

- Consumes: `getDb(env)` (Task 2), `sendEmail` (Task 4 — stubbed here, real in Task 4).
- Produces: `createAuth(env, cf?, baseURL?)` returning a Better Auth instance; `auth` static export for the CLI; an `/api/auth/*` handler; `authClient` for the browser.

- [ ] **Step 1: Define roles and permissions `src/server/auth/permissions.ts`**

```ts
import { createAccessControl } from 'better-auth/plugins/access';

const statement = {
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
} as const;

export const ac = createAccessControl(statement);

export const visitor = ac.newRole({});
export const homeowner = ac.newRole({});
export const board = ac.newRole({
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
});
```

- [ ] **Step 2: Write the full auth config `src/server/auth/index.ts`**

```ts
import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { withCloudflare } from 'better-auth-cloudflare';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { ac, visitor, homeowner, board } from './permissions';
import { sendEmail } from './senders';

export function createAuth(
  env?: Env,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  const db = env ? getDb(env) : ({} as ReturnType<typeof getDb>);

  return betterAuth({
    baseURL: baseURL ?? env?.BETTER_AUTH_URL,
    secret: env?.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false,
        cf: cf ?? {},
        d1: env ? { db, options: { usePlural: true } } : undefined,
        kv: env?.KV,
      },
      {
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: true,
          minPasswordLength: 10,
          sendResetPassword: async ({ user, url }) => {
            await sendEmail(
              env!,
              user.email,
              'Reset your HOA password',
              `Reset link: ${url}`,
            );
          },
        },
        emailVerification: {
          sendVerificationEmail: async ({ user, url }) => {
            await sendEmail(
              env!,
              user.email,
              'Verify your HOA account',
              `Verify link: ${url}`,
            );
          },
        },
        plugins: [
          admin({
            ac,
            roles: { visitor, homeowner, board },
            defaultRole: 'visitor',
            adminRoles: ['board'],
          }),
        ],
        rateLimit: { enabled: true, window: 60, max: 100 },
      },
    ),
    ...(env
      ? {}
      : {
          database: drizzleAdapter({} as Env['DATABASE'], {
            provider: 'sqlite',
            usePlural: true,
            schema,
          }),
        }),
  });
}

export const auth = createAuth();
```

- [ ] **Step 3: Mount the handler `src/pages/api/auth/[...all].ts`**

```ts
import type { APIRoute } from 'astro';
import { createAuth } from '../../../server/auth';

export const ALL: APIRoute = ({ request, locals }) => {
  const { env, cf } = locals.runtime;
  const auth = createAuth(env, cf as any, env.BETTER_AUTH_URL);
  return auth.handler(request);
};
```

- [ ] **Step 4: Create the browser client `src/lib/auth-client.ts`**

```ts
import { createAuthClient } from 'better-auth/client';
import { adminClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({ plugins: [adminClient()] });
```

- [ ] **Step 5: Write the failing handler test `test/server/auth-handler.test.ts`**

```ts
// @vitest-environment node
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS);
});

describe('auth handler', () => {
  it('rejects sign-up with a short password', async () => {
    const res = await SELF.fetch('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', password: 'short', name: 'A' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 6: Configure the workers test pool `vitest.workers.config.ts`**

```ts
import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./src/server/db/migrations');
  return {
    test: {
      include: ['test/server/**/*.test.ts'],
      poolOptions: {
        workers: {
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DATABASE'],
            kvNamespaces: ['KV'],
            bindings: { MIGRATIONS: migrations },
          },
          wrangler: { configPath: './wrangler.toml' },
        },
      },
    },
  };
});
```

Add script to `package.json`: `"test:server": "vitest run --config vitest.workers.config.ts"`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:server`
Expected: PASS (short password rejected).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: configure Better Auth on Cloudflare with roles and email verification"
```

---

## Task 4: Email and SMS senders

**Files:**

- Create: `src/server/auth/senders.ts`
- Test: `test/unit/senders.test.ts`

**Interfaces:**

- Produces: `sendEmail(env, to, subject, text)` and `sendSms(env, to, text)`, both returning `Promise<void>` and throwing on non-2xx provider responses.

- [ ] **Step 1: Write the failing test `test/unit/senders.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { sendSms } from '../../src/server/auth/senders';

describe('sendSms', () => {
  it('posts to the Twilio API and throws on failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('err', { status: 401 }));
    const env = {
      TWILIO_ACCOUNT_SID: 'AC',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM: '+1',
    } as unknown as Env;
    await expect(sendSms(env, '+15551234567', 'hi')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/senders.test.ts`
Expected: FAIL ("sendSms is not a function" / module not found).

- [ ] **Step 3: Implement `src/server/auth/senders.ts`**

```ts
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status}`);
}

export async function sendSms(
  env: Env,
  to: string,
  text: string,
): Promise<void> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({
    To: to,
    From: env.TWILIO_FROM,
    Body: text,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`sms send failed: ${res.status}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/senders.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the env var types**

Append to `worker-configuration.d.ts` is auto-generated; instead add an override `src/env.d.ts`:

```ts
interface Env {
  DATABASE: import('@cloudflare/workers-types').D1Database;
  KV: import('@cloudflare/workers-types').KVNamespace;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM: string;
  TURNSTILE_SECRET_KEY: string;
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add email (Resend) and SMS (Twilio) senders"
```

---

## Task 5: Authorization context and guards

**Files:**

- Create: `src/server/authz/context.ts`, `src/server/authz/guards.ts`
- Test: `test/unit/guards.test.ts`

**Interfaces:**

- Consumes: `createAuth(env)` (Task 3), `getDb(env)` (Task 2).
- Produces:
  - `getAuthContext(request, env): Promise<{ userId: string; role: 'visitor'|'homeowner'|'board'; ownerIds: string[] } | null>`
  - `requireRole(ctx, role): void` (throws `Forbidden` if `ctx.role` is below `role`; order visitor<homeowner<board)
  - `requireOwnerAccess(ctx, ownerId): void` (allows board, or homeowner whose `ownerIds` include `ownerId`; else throws `Forbidden`)
  - `class Forbidden extends Error` and `class Unauthorized extends Error`

- [ ] **Step 1: Write the failing test `test/unit/guards.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  requireRole,
  requireOwnerAccess,
  Forbidden,
} from '../../src/server/authz/guards';

const homeownerCtx = {
  userId: 'u1',
  role: 'homeowner' as const,
  ownerIds: ['o1'],
};
const boardCtx = { userId: 'u2', role: 'board' as const, ownerIds: [] };

describe('guards', () => {
  it('requireRole rejects a homeowner from board-only access', () => {
    expect(() => requireRole(homeownerCtx, 'board')).toThrow(Forbidden);
  });
  it('requireRole allows board for homeowner-level access', () => {
    expect(() => requireRole(boardCtx, 'homeowner')).not.toThrow();
  });
  it('requireOwnerAccess blocks a homeowner from another owner record', () => {
    expect(() => requireOwnerAccess(homeownerCtx, 'o2')).toThrow(Forbidden);
  });
  it('requireOwnerAccess allows a homeowner for their own owner record', () => {
    expect(() => requireOwnerAccess(homeownerCtx, 'o1')).not.toThrow();
  });
  it('requireOwnerAccess allows board for any owner record', () => {
    expect(() => requireOwnerAccess(boardCtx, 'o2')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/guards.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server/authz/guards.ts`**

```ts
export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export type Role = 'visitor' | 'homeowner' | 'board';
export interface AuthContext {
  userId: string;
  role: Role;
  ownerIds: string[];
}

const RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

export function requireRole(ctx: AuthContext, role: Role): void {
  if (RANK[ctx.role] < RANK[role]) throw new Forbidden(`requires ${role}`);
}

export function requireOwnerAccess(ctx: AuthContext, ownerId: string): void {
  if (ctx.role === 'board') return;
  if (ctx.role === 'homeowner' && ctx.ownerIds.includes(ownerId)) return;
  throw new Forbidden('not your property');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/guards.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/server/authz/context.ts`**

```ts
import { eq } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb } from '../db/client';
import { userPropertyLinks, users } from '../db/schema';
import type { AuthContext, Role } from './guards';

export async function getAuthContext(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  const db = getDb(env);
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, session.user.id));
  const role = (row?.role as Role) ?? 'visitor';
  const links = await db
    .select({ ownerId: userPropertyLinks.ownerId })
    .from(userPropertyLinks)
    .where(eq(userPropertyLinks.userId, session.user.id));
  return {
    userId: session.user.id,
    role,
    ownerIds: links.map((l) => l.ownerId),
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add server-side authorization context and role/owner guards"
```

---

## Task 6: One-time code generation, hashing, and attempt limiting

**Files:**

- Create: `src/server/verification/codes.ts`
- Test: `test/unit/codes.test.ts`

**Interfaces:**

- Produces:
  - `generateCode(): string` — 6-digit numeric string
  - `hashCode(code: string): Promise<string>` — SHA-256 hex
  - `verifyCode(code: string, hash: string): Promise<boolean>` — constant-ish compare via re-hash
  - `MAX_ATTEMPTS = 5`, `CODE_TTL_MS = 600_000`

- [ ] **Step 1: Write the failing test `test/unit/codes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
} from '../../src/server/verification/codes';

describe('codes', () => {
  it('generates a 6-digit numeric code', () => {
    expect(generateCode()).toMatch(/^\d{6}$/);
  });
  it('verifies a matching code and rejects a wrong one', async () => {
    const code = '123456';
    const hash = await hashCode(code);
    expect(await verifyCode('123456', hash)).toBe(true);
    expect(await verifyCode('000000', hash)).toBe(false);
  });
  it('exposes an attempt cap', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/codes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server/verification/codes.ts`**

```ts
export const MAX_ATTEMPTS = 5;
export const CODE_TTL_MS = 600_000;

export function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

export async function hashCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyCode(code: string, hash: string): Promise<boolean> {
  return (await hashCode(code)) === hash;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add one-time verification code utilities"
```

---

## Task 7: Roster lookup

**Files:**

- Create: `src/server/roster/lookup.ts`
- Test: `test/unit/roster-lookup.test.ts`

**Interfaces:**

- Produces:
  - `normalizeAddress(raw: string): string` — lowercased, trimmed, collapsed whitespace, punctuation stripped
  - `findActiveOwnerByAddress(db, address): Promise<Owner | null>` where `Owner` is the inferred `owners` row type

- [ ] **Step 1: Write the failing test `test/unit/roster-lookup.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeAddress } from '../../src/server/roster/lookup';

describe('normalizeAddress', () => {
  it('canonicalizes case, spacing, and punctuation', () => {
    expect(normalizeAddress('  9904   Wishing Willow Dr. ')).toBe(
      '9904 wishing willow dr',
    );
    expect(normalizeAddress('9904 WISHING WILLOW DR')).toBe(
      '9904 wishing willow dr',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/roster-lookup.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server/roster/lookup.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { owners } from '../db/schema';

export function normalizeAddress(raw: string): string {
  return raw.toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

export async function findActiveOwnerByAddress(db: Db, address: string) {
  const norm = normalizeAddress(address);
  const [owner] = await db
    .select()
    .from(owners)
    .where(
      and(eq(owners.addressNormalized, norm), eq(owners.status, 'active')),
    );
  return owner ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/roster-lookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add roster address normalization and lookup"
```

---

## Task 8: Property verification flow (request + confirm)

**Files:**

- Create: `src/server/verification/property.ts`, `src/pages/api/verify/request.ts`, `src/pages/api/verify/confirm.ts`
- Test: `test/server/verification.test.ts`

**Interfaces:**

- Consumes: `getAuthContext` (Task 5), `findActiveOwnerByAddress` (Task 7), codes (Task 6), senders (Task 4), `getDb` (Task 2), `createAuth` (Task 3).
- Produces:
  - `requestPropertyVerification(env, userId, address, channel): Promise<{ ok: true } | { ok: false; queued: true }>`
  - `confirmPropertyVerification(env, userId, code): Promise<{ ok: boolean; reason?: 'expired'|'locked'|'mismatch' }>`
  - on success, confirm inserts a `userPropertyLinks` row and sets the user's role to `homeowner` (never higher).

- [ ] **Step 1: Write the failing integration test `test/server/verification.test.ts`**

```ts
// @vitest-environment node
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS);
});

describe('property verification', () => {
  it('queues for manual approval when the address is not on the roster', async () => {
    const { requestPropertyVerification } =
      await import('../../src/server/verification/property');
    const result = await requestPropertyVerification(
      env,
      'user-x',
      '0000 Nonexistent St',
      'email',
    );
    expect(result).toEqual({ ok: false, queued: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/server/verification/property.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import { createAuth } from '../auth';
import { sendEmail, sendSms } from '../auth/senders';
import { findActiveOwnerByAddress } from '../roster/lookup';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
  CODE_TTL_MS,
} from './codes';
import {
  manualApprovalQueue,
  propertyVerifications,
  userPropertyLinks,
} from '../db/schema';

export async function requestPropertyVerification(
  env: Env,
  userId: string,
  address: string,
  channel: 'email' | 'sms',
): Promise<{ ok: true } | { ok: false; queued: true }> {
  const db = getDb(env);
  const owner = await findActiveOwnerByAddress(db, address);
  const now = new Date();
  if (
    !owner ||
    (channel === 'email' && !owner.email) ||
    (channel === 'sms' && !owner.phone)
  ) {
    await db.insert(manualApprovalQueue).values({
      id: crypto.randomUUID(),
      userId,
      claimedAddress: address,
      reason: owner ? 'no contact on file for channel' : 'address not found',
      status: 'pending',
      createdAt: now,
    });
    return { ok: false, queued: true };
  }
  const code = generateCode();
  await db.insert(propertyVerifications).values({
    id: crypto.randomUUID(),
    userId,
    ownerId: owner.id,
    channel,
    codeHash: await hashCode(code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    attempts: 0,
    consumedAt: null,
    createdAt: now,
  });
  const message = `Your Valleys at Ashebrook verification code is ${code}. It expires in 10 minutes.`;
  if (channel === 'email')
    await sendEmail(env, owner.email!, 'Your HOA verification code', message);
  else await sendSms(env, owner.phone!, message);
  return { ok: true };
}

export async function confirmPropertyVerification(
  env: Env,
  userId: string,
  code: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'locked' | 'mismatch' }> {
  const db = getDb(env);
  const [pv] = await db
    .select()
    .from(propertyVerifications)
    .where(
      and(
        eq(propertyVerifications.userId, userId),
        isNull(propertyVerifications.consumedAt),
      ),
    )
    .orderBy(propertyVerifications.createdAt);
  if (!pv) return { ok: false, reason: 'mismatch' };
  if (pv.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (pv.expiresAt.getTime() < Date.now())
    return { ok: false, reason: 'expired' };
  if (!(await verifyCode(code, pv.codeHash))) {
    await db
      .update(propertyVerifications)
      .set({ attempts: pv.attempts + 1 })
      .where(eq(propertyVerifications.id, pv.id));
    return { ok: false, reason: 'mismatch' };
  }
  await db
    .update(propertyVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(propertyVerifications.id, pv.id));
  await db.insert(userPropertyLinks).values({
    id: crypto.randomUUID(),
    userId,
    ownerId: pv.ownerId,
    verifiedAt: new Date(),
    method: pv.channel === 'email' ? 'otp_email' : 'otp_sms',
  });
  const auth = createAuth(env);
  await auth.api.setRole({
    body: { userId, role: 'homeowner' },
    headers: new Headers(),
  });
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server`
Expected: PASS (unknown address is queued).

- [ ] **Step 5: Add the request endpoint `src/pages/api/verify/request.ts`**

```ts
import type { APIRoute } from 'astro';
import { getAuthContext } from '../../../server/authz/context';
import { requestPropertyVerification } from '../../../server/verification/property';
import { verifyTurnstile } from '../../../server/authz/turnstile';

export const POST: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const { address, channel, turnstileToken } = await request.json();
  if (!(await verifyTurnstile(env, turnstileToken, request)))
    return new Response('Bad captcha', { status: 400 });
  const result = await requestPropertyVerification(
    env,
    ctx.userId,
    address,
    channel,
  );
  return Response.json(result);
};
```

- [ ] **Step 6: Add the confirm endpoint `src/pages/api/verify/confirm.ts`**

```ts
import type { APIRoute } from 'astro';
import { getAuthContext } from '../../../server/authz/context';
import { confirmPropertyVerification } from '../../../server/verification/property';

export const POST: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const { code } = await request.json();
  const result = await confirmPropertyVerification(env, ctx.userId, code);
  return Response.json(result, { status: result.ok ? 200 : 400 });
};
```

- [ ] **Step 7: Add Turnstile verification `src/server/authz/turnstile.ts`**

```ts
export async function verifyTurnstile(
  env: Env,
  token: string,
  request: Request,
): Promise<boolean> {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: request.headers.get('cf-connecting-ip') ?? '',
  });
  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body },
  );
  const data = (await res.json()) as { success: boolean };
  return data.success;
}
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add possession-based property verification flow and endpoints"
```

---

## Task 9: Admin roster endpoints (board only)

**Files:**

- Create: `src/pages/api/admin/owners.ts`
- Test: `test/server/admin-owners.test.ts`

**Interfaces:**

- Consumes: `getAuthContext` + `requireRole` (Task 5), `getDb` (Task 2).
- Produces: `GET /api/admin/owners` (list), `POST` (create), `PATCH` (update incl. status). All require `board`.

- [ ] **Step 1: Write the failing test `test/server/admin-owners.test.ts`**

```ts
// @vitest-environment node
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS);
});

describe('admin owners', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/owners');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server`
Expected: FAIL (route returns 404, not 401).

- [ ] **Step 3: Implement `src/pages/api/admin/owners.ts`**

```ts
import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { getAuthContext } from '../../../server/authz/context';
import { requireRole, Forbidden } from '../../../server/authz/guards';
import { getDb } from '../../../server/db/client';
import { owners } from '../../../server/db/schema';
import { normalizeAddress } from '../../../server/roster/lookup';

async function guard(request: Request, env: Env) {
  const ctx = await getAuthContext(request, env);
  if (!ctx) throw new Response('Unauthorized', { status: 401 });
  requireRole(ctx, 'board');
  return ctx;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  try {
    await guard(request, env);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  const rows = await getDb(env).select().from(owners);
  return Response.json(rows);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  try {
    await guard(request, env);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  const body = await request.json();
  const now = new Date();
  await getDb(env)
    .insert(owners)
    .values({
      id: crypto.randomUUID(),
      fullName: body.fullName,
      address: body.address,
      addressNormalized: normalizeAddress(body.address),
      unit: body.unit ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      status: 'active',
      notes: body.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });
  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  try {
    await guard(request, env);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  const body = await request.json();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of [
    'fullName',
    'address',
    'unit',
    'phone',
    'email',
    'status',
    'notes',
  ]) {
    if (k in body) patch[k] = body[k];
  }
  if ('address' in body)
    patch.addressNormalized = normalizeAddress(body.address);
  await getDb(env).update(owners).set(patch).where(eq(owners.id, body.id));
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server`
Expected: PASS (401 for unauthenticated).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add board-only roster management endpoints"
```

---

## Task 10: Admin member-review, revoke, and role-grant endpoints (board only)

**Files:**

- Create: `src/pages/api/admin/members.ts`, `src/pages/api/admin/roles.ts`
- Test: `test/server/admin-roles.test.ts`

**Interfaces:**

- Consumes: `getAuthContext` + `requireRole` (Task 5), `createAuth` (Task 3), `getDb` (Task 2).
- Produces:
  - `GET /api/admin/members` — recent homeowner signups + the manual-approval queue
  - `POST /api/admin/members` — `{ action: 'revoke'|'approve'|'deny', ... }`
  - `POST /api/admin/roles` — `{ userId, role: 'homeowner'|'board', action: 'grant'|'revoke' }` (board only)

- [ ] **Step 1: Write the failing test `test/server/admin-roles.test.ts`**

```ts
// @vitest-environment node
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS);
});

describe('admin roles', () => {
  it('rejects unauthenticated role grant with 401', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u', role: 'board', action: 'grant' }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server`
Expected: FAIL (404, not 401).

- [ ] **Step 3: Implement `src/pages/api/admin/roles.ts`**

```ts
import type { APIRoute } from 'astro';
import { getAuthContext } from '../../../server/authz/context';
import { requireRole, Forbidden } from '../../../server/authz/guards';
import { createAuth } from '../../../server/auth';

export const POST: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  try {
    requireRole(ctx, 'board');
  } catch (e) {
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  const { userId, role, action } = await request.json();
  if (!['homeowner', 'board'].includes(role))
    return new Response('Bad role', { status: 400 });
  const auth = createAuth(env);
  const target = action === 'revoke' ? 'visitor' : role;
  await auth.api.setRole({
    body: { userId, role: target },
    headers: request.headers,
  });
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: Implement `src/pages/api/admin/members.ts`**

```ts
import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { getAuthContext } from '../../../server/authz/context';
import { requireRole, Forbidden } from '../../../server/authz/guards';
import { getDb } from '../../../server/db/client';
import {
  manualApprovalQueue,
  userPropertyLinks,
  users,
} from '../../../server/db/schema';

function guard(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
): Response | null {
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  try {
    requireRole(ctx, 'board');
  } catch (e) {
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }
  return null;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  const ctx = await getAuthContext(request, env);
  const denied = guard(ctx);
  if (denied) return denied;
  const db = getDb(env);
  const recent = await db
    .select()
    .from(users)
    .where(eq(users.role, 'homeowner'))
    .limit(50);
  const queue = await db
    .select()
    .from(manualApprovalQueue)
    .where(eq(manualApprovalQueue.status, 'pending'))
    .orderBy(desc(manualApprovalQueue.createdAt));
  return Response.json({ recent, queue });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { env } = locals.runtime;
  const ctx = await getAuthContext(request, env);
  const denied = guard(ctx);
  if (denied) return denied;
  const db = getDb(env);
  const body = await request.json();
  if (body.action === 'revoke') {
    await db
      .delete(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, body.userId));
    const { createAuth } = await import('../../../server/auth');
    await createAuth(env).api.setRole({
      body: { userId: body.userId, role: 'visitor' },
      headers: request.headers,
    });
  } else if (body.action === 'approve' || body.action === 'deny') {
    await db
      .update(manualApprovalQueue)
      .set({ status: body.action === 'approve' ? 'approved' : 'denied' })
      .where(eq(manualApprovalQueue.id, body.queueId));
  }
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add board-only member review, revoke, and role-grant endpoints"
```

---

## Task 11: Roster import script

**Files:**

- Create: `scripts/import-roster.ts`
- Modify: `package.json` (script + `xlsx` dev dep)
- Test: `test/unit/roster-import.test.ts`

**Interfaces:**

- Consumes: `normalizeAddress` (Task 7).
- Produces: `rowsToOwners(rows: Record<string, string>[]): NewOwner[]` (pure mapping, unit-tested) and a CLI that reads `private/HOA_files/Ashebrook HOA Contact List.xlsx` and bulk-inserts via `wrangler d1 execute`.

- [ ] **Step 1: Install the parser**

```bash
npm install -D xlsx
```

- [ ] **Step 2: Write the failing test `test/unit/roster-import.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { rowsToOwners } from '../../scripts/import-roster';

describe('rowsToOwners', () => {
  it('maps spreadsheet rows to owner records with normalized addresses', () => {
    const out = rowsToOwners([
      {
        Name: 'Jane Doe',
        Address: '9904 Wishing Willow Dr.',
        Phone: '5551234567',
        Email: 'jane@x.com',
      },
    ]);
    expect(out[0]).toMatchObject({
      fullName: 'Jane Doe',
      address: '9904 Wishing Willow Dr.',
      addressNormalized: '9904 wishing willow dr',
      phone: '5551234567',
      email: 'jane@x.com',
      status: 'active',
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/roster-import.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `scripts/import-roster.ts`**

```ts
import { normalizeAddress } from '../src/server/roster/lookup';

export interface NewOwner {
  fullName: string;
  address: string;
  addressNormalized: string;
  unit: string | null;
  phone: string | null;
  email: string | null;
  status: 'active';
}

export function rowsToOwners(rows: Record<string, string>[]): NewOwner[] {
  return rows.map((r) => ({
    fullName: (r.Name ?? r['Owner'] ?? '').trim(),
    address: (r.Address ?? '').trim(),
    addressNormalized: normalizeAddress(r.Address ?? ''),
    unit: r.Unit?.trim() || null,
    phone: r.Phone?.replace(/\D/g, '') || null,
    email: r.Email?.trim() || null,
    status: 'active',
  }));
}

// CLI: read the xlsx and emit SQL applied via wrangler.
async function main() {
  const XLSX = await import('xlsx');
  const wb = XLSX.readFile('private/HOA_files/Ashebrook HOA Contact List.xlsx');
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    wb.Sheets[wb.SheetNames[0]],
  );
  const owners = rowsToOwners(rows);
  const values = owners
    .map(
      (o) =>
        `('${crypto.randomUUID()}', ${sql(o.fullName)}, ${sql(o.address)}, ${sql(o.addressNormalized)}, ${sql(o.unit)}, ${sql(o.phone)}, ${sql(o.email)}, 'active', NULL, unixepoch(), unixepoch())`,
    )
    .join(',\n');
  const stmt = `INSERT INTO owners (id, full_name, address, address_normalized, unit, phone, email, status, notes, created_at, updated_at) VALUES\n${values};`;
  await import('node:fs').then((fs) =>
    fs.writeFileSync('private/roster-import.sql', stmt),
  );
  console.log(
    'Wrote private/roster-import.sql — apply with: wrangler d1 execute ashebrook-hoa --remote --file private/roster-import.sql',
  );
}

function sql(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/roster-import.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the import script to `package.json`**

```json
"roster:import": "node --experimental-strip-types scripts/import-roster.ts"
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add owner roster import from the HOA contact list"
```

---

## Task 12: Seed the first board account (bootstrap)

**Files:**

- Create: `scripts/seed-board.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `createAuth` (Task 3).
- Produces: a one-off script that creates a user and sets role `board`, run once after deploy.

- [ ] **Step 1: Implement `scripts/seed-board.ts`**

```ts
// Run with the Worker bindings available (wrangler dev / deployed admin task).
// Usage: provide BOARD_EMAIL and BOARD_PASSWORD env vars.
import { createAuth } from '../src/server/auth';

export async function seedBoard(
  env: Env,
  email: string,
  password: string,
  name: string,
) {
  const auth = createAuth(env);
  const created = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  await auth.api.setRole({
    body: { userId: created.user.id, role: 'board' },
    headers: new Headers(),
  });
  return created.user.id;
}
```

- [ ] **Step 2: Document the run step**

Add to `SETUP.md` a "Create the first board account" section: deploy, then invoke `seedBoard` via a temporary admin route or `wrangler dev` REPL with `BOARD_EMAIL`/`BOARD_PASSWORD` set, then delete the temporary route. (No automated test — this is a one-time bootstrap; it reuses Task 3's tested `createAuth`.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add board bootstrap seed script"
```

---

## Task 13: Astro auth UI and protected-route gating

**Files:**

- Create: `src/pages/login.astro`, `src/pages/register.astro`, `src/pages/verify-property.astro`, `src/components/react/AuthForms.tsx`, `src/middleware.ts`
- Test: `test/server/middleware.test.ts`

**Interfaces:**

- Consumes: `authClient` (Task 3), `getAuthContext` (Task 5).
- Produces: login/register/verify pages; middleware that attaches `locals.authContext` and blocks `/admin/*` for non-board and homeowner-only pages for visitors.

- [ ] **Step 1: Write the failing middleware test `test/server/middleware.test.ts`**

```ts
// @vitest-environment node
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS);
});

describe('route protection', () => {
  it('redirects an anonymous visitor away from /admin', async () => {
    const res = await SELF.fetch('http://localhost/admin', {
      redirect: 'manual',
    });
    expect([302, 401]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server`
Expected: FAIL (no protection yet; route 200 or 404).

- [ ] **Step 3: Implement `src/middleware.ts`**

```ts
import { defineMiddleware } from 'astro:middleware';
import { getAuthContext } from './server/authz/context';

export const onRequest = defineMiddleware(async (context, next) => {
  const env = context.locals.runtime.env;
  const ctx = await getAuthContext(context.request, env);
  context.locals.authContext = ctx;
  const path = context.url.pathname;
  if (path.startsWith('/admin') && ctx?.role !== 'board') {
    return context.redirect('/login', 302);
  }
  if (path.startsWith('/homeowner') && (!ctx || ctx.role === 'visitor')) {
    return context.redirect('/login', 302);
  }
  return next();
});
```

- [ ] **Step 4: Add the `App.Locals` type augmentation in `src/env.d.ts`**

```ts
declare namespace App {
  interface Locals {
    runtime: {
      env: Env;
      cf: import('@cloudflare/workers-types').IncomingRequestCfProperties;
    };
    authContext: import('./server/authz/guards').AuthContext | null;
  }
}
```

- [ ] **Step 5: Build the React auth forms `src/components/react/AuthForms.tsx`**

```tsx
import { useState } from 'react';
import { authClient } from '../../lib/auth-client';

export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await authClient.signUp.email({ email, password, name });
    setMsg(
      error
        ? (error.message ?? 'Error')
        : 'Check your email to verify your account.',
    );
  }
  return (
    <form onSubmit={onSubmit}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full name"
        required
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password (10+ chars)"
        required
        minLength={10}
      />
      <button type="submit">Create account</button>
      {msg && <p>{msg}</p>}
    </form>
  );
}

export function VerifyPropertyForm() {
  const [address, setAddress] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'request' | 'confirm'>('request');
  const [msg, setMsg] = useState('');
  async function request(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/verify/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address,
        channel,
        turnstileToken: (window as any).turnstileToken,
      }),
    });
    const data = await res.json();
    setMsg(
      data.queued
        ? 'Sent to the board for manual review.'
        : 'Code sent — check your phone/email.',
    );
    if (data.ok) setStage('confirm');
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/verify/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    setMsg(
      res.ok
        ? 'Verified! You now have homeowner access.'
        : 'Code invalid or expired.',
    );
  }
  return stage === 'request' ? (
    <form onSubmit={request}>
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Your property address"
        required
      />
      <select
        value={channel}
        onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}
      >
        <option value="email">Email me the code</option>
        <option value="sms">Text me the code</option>
      </select>
      <button type="submit">Send code</button>
      {msg && <p>{msg}</p>}
    </form>
  ) : (
    <form onSubmit={confirm}>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="6-digit code"
        required
      />
      <button type="submit">Verify</button>
      {msg && <p>{msg}</p>}
    </form>
  );
}
```

- [ ] **Step 6: Create the pages mounting the islands**

`src/pages/register.astro`, `src/pages/login.astro`, `src/pages/verify-property.astro` each wrap `BaseLayout` and mount the matching React island with `client:only="react"` (login uses `authClient.signIn.email`; pattern mirrors `RegisterForm`). Include the Cloudflare Turnstile widget script on `verify-property.astro` and store its token on `window.turnstileToken`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:server`
Expected: PASS (anonymous `/admin` redirects).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add auth UI, property verification UI, and route protection middleware"
```

---

## Task 14: Retire Firebase Auth from the board admin app

**Files:**

- Modify: `src/components/admin/useAuth.ts`, `src/components/admin/AdminApp.tsx`, `src/components/admin/Login.tsx`
- Remove (later sub-projects): `src/lib/firebase.ts` usage — out of scope here beyond auth
- Test: `test/server/admin-gate.test.ts`

**Interfaces:**

- Consumes: `authClient` (Task 3), middleware role gate (Task 13).
- Produces: the `/admin` app authenticates via Better Auth sessions and shows content only to `board`.

- [ ] **Step 1: Write the failing test `test/server/admin-gate.test.ts`**

```ts
// @vitest-environment node
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS);
});

describe('admin gate', () => {
  it('does not serve admin content to an anonymous request', async () => {
    const res = await SELF.fetch('http://localhost/admin', {
      redirect: 'manual',
    });
    expect(res.status).not.toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `npm run test:server`
Expected: PASS already if middleware from Task 13 covers `/admin` — confirm, then proceed to swap the client code so the UI matches the new session model.

- [ ] **Step 3: Replace `useAuth.ts` to read Better Auth sessions**

```ts
import { authClient } from '../../lib/auth-client';

export function useAuth() {
  const { data, isPending } = authClient.useSession();
  const role = (data?.user as { role?: string } | undefined)?.role ?? 'visitor';
  return {
    loading: isPending,
    user: data?.user ?? null,
    isAdmin: role === 'board',
  };
}
```

- [ ] **Step 4: Point `Login.tsx` at Better Auth**

Replace the Firebase `signInWithEmailAndPassword` call with `authClient.signIn.email({ email, password })` and the reset link with `authClient.forgetPassword({ email, redirectTo: '/reset' })`. Keep the existing markup.

- [ ] **Step 5: Remove the Firebase admin-check path in `AdminApp.tsx`**

Delete the `checkIsAdmin`/Firestore `/admins` logic; rely on `useAuth().isAdmin` (role `board`). Leave the manager components untouched (they move to D1 in later sub-projects).

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run test:server && npm run check`
Expected: PASS, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: migrate board admin login from Firebase Auth to Better Auth"
```

---

## Self-review notes (coverage against the spec)

- **Roles & access model** → Tasks 3 (roles/admin plugin), 5 (guards), 13 (route gate).
- **Possession-based verification** → Tasks 6 (codes), 7 (roster lookup), 8 (request/confirm + Turnstile + lockout).
- **Roster as source of truth + import** → Tasks 2 (schema), 9 (CRUD), 11 (import).
- **Data model** → Task 2.
- **Authorization (server-side, per-owner)** → Task 5 (`requireOwnerAccess`), enforced in endpoints (Tasks 8–10) and middleware (Task 13).
- **Admin surface** → Tasks 9, 10.
- **Edge cases** → manual-approval queue (Tasks 8, 10), transfer = `status:'inactive'` (Task 9 PATCH), co-owners/multi-property (many-to-many link table, Task 2).
- **Board never self-granted** → role only set to `homeowner` on verification (Task 8); `board` only via Task 10 + bootstrap (Task 12).
- **Migration from Firebase** → Task 14.
- **Testing strategy** → unit tests (Tasks 4–7, 11) + Worker/D1 integration tests (Tasks 3, 8–10, 13–14).

Deferred per spec (not in this plan): per-owner dues/violations tables, SMS-provider final selection (Twilio assumed), tenant accounts.
