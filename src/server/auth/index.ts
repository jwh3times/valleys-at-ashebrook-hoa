import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { withCloudflare } from 'better-auth-cloudflare';
import type {
  CloudflareGeolocation,
  WithCloudflareOptions,
} from 'better-auth-cloudflare';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { ac, visitor, homeowner, board } from './permissions';
import { sendEmail } from './senders';
import { SITE_NAME } from '../../lib/site';

// Which origins may make state-changing auth requests, given the origin this
// deployment is actually served from. localhost is trusted only when the app is
// configured to run there, and production sets BETTER_AUTH_URL in wrangler.toml's
// [vars], so a production deployment never carries a development origin. With no
// base URL configured at all, Better Auth infers one from the request and trusts
// it — this list is an addition to that, not a replacement for it.
function trustedOriginsFor(baseURL: string | undefined): string[] {
  const origins = ['https://ashebrookresidents.com'];
  if (baseURL?.startsWith('http://localhost')) {
    origins.push('http://localhost:4321');
  }
  return origins;
}

function createAuthUncached(
  env?: Env,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  return betterAuth({
    baseURL: baseURL ?? env?.BETTER_AUTH_URL,
    secret: env?.BETTER_AUTH_SECRET,
    // Origins allowed to make auth requests. The list carries exactly the hosts an
    // auth request can actually be served from, and nothing else:
    //   - the canonical apex, always;
    //   - `http://localhost:4321` only when the app is configured to run there, so
    //     a production deployment never carries a development origin.
    // `www` is deliberately absent: the zone 301-redirects it at the edge, so no
    // request ever completes on that host. The `workers.dev` origin is absent for
    // the same reason — the route is disabled in the dashboard and pinned off by
    // `workers_dev`/`preview_urls` in wrangler.toml.
    trustedOrigins: trustedOriginsFor(baseURL ?? env?.BETTER_AUTH_URL),
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false,
        // Cast to CloudflareGeolocation — IncomingRequestCfProperties is a superset;
        // an empty object satisfies the check that cf is truthy (required when
        // autoDetectIpAddress is true).
        cf: (cf ?? {}) as CloudflareGeolocation,
        // Better Auth's Drizzle adapter needs the schema to resolve models (e.g.
        // "users"). withCloudflare spreads d1.options straight into drizzleAdapter,
        // so pass `schema` there; usePlural matches our plural table names.
        d1: env
          ? { db: drizzle(env.DATABASE), options: { usePlural: true, schema } }
          : undefined,
        // better-auth-cloudflare still publishes its KV boundary against
        // @cloudflare/workers-types. The generated Wrangler type is the runtime
        // source of truth for this app; bridge the package's legacy declaration
        // at the integration boundary until that dependency migrates too.
        kv: env?.KV as unknown as WithCloudflareOptions['kv'],
      },
      {
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: true,
          minPasswordLength: 10,
          sendResetPassword: async ({ user, url }) => {
            if (!env) return;
            try {
              await sendEmail(
                env,
                user.email,
                `Reset your password — ${SITE_NAME}`,
                `Reset link: ${url}`,
              );
            } catch (err) {
              console.error('[auth] sendResetPassword failed:', err);
            }
          },
        },
        emailVerification: {
          // Send the verification email immediately on sign-up (default is false,
          // which only sends on a subsequent sign-in attempt) so it matches the
          // "check your email" message the register form shows.
          sendOnSignUp: true,
          sendVerificationEmail: async ({ user, url }) => {
            if (!env) return;
            try {
              await sendEmail(
                env,
                user.email,
                `Verify your account — ${SITE_NAME}`,
                `Verify link: ${url}`,
              );
            } catch (err) {
              console.error('[auth] sendVerificationEmail failed:', err);
            }
          },
        },
        // Single-use reset tokens require atomic consumption in 1.7. The KV
        // adapter lacks getAndDelete; the existing D1 verifications table has
        // an atomic DELETE RETURNING path through the Drizzle adapter.
        verification: { storeInDatabase: true },
        plugins: [
          admin({
            ac,
            roles: { visitor, homeowner, board },
            defaultRole: 'visitor',
            adminRoles: ['board'],
          }),
        ],
        // D1 provides atomic guarded increments across Worker instances. The KV
        // adapter has no increment primitive required by Better Auth 1.7.
        rateLimit: { enabled: true, window: 60, max: 100, storage: 'database' },
      },
    ),
    // Fallback database for the no-arg `auth` export (used by the auth CLI only).
    // In normal runtime, the database comes from withCloudflare's d1 option above.
    ...(env
      ? {}
      : {
          database: drizzleAdapter({} as never, {
            provider: 'sqlite',
            usePlural: true,
            schema,
          }),
        }),
  });
}

type AuthInstance = ReturnType<typeof createAuthUncached>;

const runtimeAuthCache = new WeakMap<object, Map<string, AuthInstance>>();

export function createAuth(
  env?: Env,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  if (!env || cf) return createAuthUncached(env, cf, baseURL);

  const envKey = env as object;
  const baseUrlKey = baseURL ?? env.BETTER_AUTH_URL ?? '';
  let byBaseUrl = runtimeAuthCache.get(envKey);
  if (!byBaseUrl) {
    byBaseUrl = new Map();
    runtimeAuthCache.set(envKey, byBaseUrl);
  }

  let auth = byBaseUrl.get(baseUrlKey);
  if (!auth) {
    auth = createAuthUncached(env, undefined, baseURL);
    byBaseUrl.set(baseUrlKey, auth);
  }
  return auth;
}

// No-arg export for the Better Auth CLI (`npm run auth:generate`). This is
// intentionally load-bearing unless the CLI config path is changed in tandem.
export const auth = createAuth();
