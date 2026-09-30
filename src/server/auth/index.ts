import { betterAuth } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin } from 'better-auth/plugins';
import { APIError, BASE_ERROR_CODES } from '@better-auth/core/error';
import type { GoogleProfile } from '@better-auth/core/social-providers';
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

/**
 * Google sign-in is optional: without both credentials the provider is absent,
 * `/sign-in/social` answers 404 `PROVIDER_NOT_FOUND`, and email/password is
 * untouched. Pages ask this before offering a Google button.
 */
export function isGoogleSignInConfigured(env?: Env): boolean {
  return Boolean(env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET);
}

function decodeIdTokenClaims(idToken: string): Partial<GoogleProfile> | null {
  try {
    const payload = idToken.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return JSON.parse(
      new TextDecoder().decode(bytes),
    ) as Partial<GoogleProfile>;
  } catch {
    return null;
  }
}

// Only an identity whose email Google has verified exists at all. Better Auth's
// own `requireEmailVerification` withholds the session but still CREATES the
// user and links the Google identity to it first — a pre-account-takeover
// seed for someone else's address — and its unverified-email outcomes differ
// by whether an Account already uses the address. Refusing here, before any
// lookup, answers every unverified identity the same `unable_to_get_user_info`.
// The claims come from the token response Better Auth fetched from Google
// over TLS, exactly as its default implementation trusts them.
async function verifiedGoogleUserInfo(token: { idToken?: string }) {
  const claims = token.idToken ? decodeIdTokenClaims(token.idToken) : null;
  if (!claims?.sub || claims.email_verified !== true) return null;
  // The account ID is Google's `sub`, which Better Auth reads from `data`.
  // No `image`: the site never shows a profile photo, so it does not keep
  // Google's (the privacy policy at /privacy says so).
  return {
    user: {
      name: claims.name ?? '',
      email: claims.email,
      emailVerified: true,
    },
    data: claims as GoogleProfile,
  };
}

// A personal identity login (#415), never a Drive connection: the default
// openid/email/profile scopes only, and `includeGrantedScopes: false` so Google
// cannot fold other scopes this client was ever granted into the token. The
// redirect flow is the only entry — a bare ID token posted to /sign-in/social
// is refused.
function socialProvidersFor(env?: Env) {
  if (!env || !isGoogleSignInConfigured(env)) return {};
  return {
    google: {
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      prompt: 'select_account' as const,
      includeGrantedScopes: false,
      disableIdTokenSignIn: true,
      getUserInfo: verifiedGoogleUserInfo,
    },
  };
}

// Sign-in needs only the provider identity (`accounts.account_id`), so the
// provider tokens are never stored: an identity-scoped token has no use here,
// and a row that holds none cannot leak one. A before-hook's `data` is MERGED
// over the write, so the fields are nulled rather than omitted. Credential
// rows never carry them, so this touches only social rows in effect.
const NO_PROVIDER_TOKENS = {
  data: {
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  },
};

const SOCIAL_FLOW_PATHS = new Set(['/sign-in/social', '/link-social']);

// Two guards on the paths that start a Google redirect:
//  - The request cannot widen the login. Both routes accept caller-supplied
//    `scopes` and `additionalParams` (which could re-enable
//    include_granted_scopes); the site sends neither, so a body carrying one
//    is refused rather than trusted to be harmless.
//  - Linking a provider changes how the Account can be entered, so it demands
//    the same fresh session Better Auth already requires to unlink one.
//    `/link-social` itself only checks for a session.
const guardSocialFlows = createAuthMiddleware(async (ctx) => {
  if (!SOCIAL_FLOW_PATHS.has(ctx.path)) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (body.scopes !== undefined || body.additionalParams !== undefined) {
    throw new APIError('BAD_REQUEST', {
      code: 'IDENTITY_SCOPES_ONLY',
      message: 'Sign-in requests identity scopes only.',
    });
  }
  if (ctx.path !== '/link-social') return;
  const session = await getSessionFromCtx(ctx);
  // No session: the endpoint's own session check answers 401.
  if (!session) return;
  const freshAge = ctx.context.sessionConfig.freshAge;
  const age = Date.now() - new Date(session.session.createdAt).getTime();
  if (freshAge !== 0 && age >= freshAge * 1000) {
    throw APIError.from('FORBIDDEN', BASE_ERROR_CODES.SESSION_NOT_FRESH);
  }
});

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
        socialProviders: socialProvidersFor(env),
        account: {
          accountLinking: {
            enabled: true,
            // A Google identity whose email matches an existing Account is
            // refused (`account_not_linked`), never merged: linking happens
            // only from that Account's own signed-in session, via /link-social,
            // where the provider email must be verified and must equal the
            // Account email. No provider is trusted to skip those checks.
            disableImplicitLinking: true,
            allowDifferentEmails: false,
            trustedProviders: [],
            updateUserInfoOnLink: false,
          },
        },
        databaseHooks: {
          account: {
            create: { before: async () => NO_PROVIDER_TOKENS },
            update: { before: async () => NO_PROVIDER_TOKENS },
          },
        },
        hooks: { before: guardSocialFlows },
        // Provider-token retrieval is not a feature of this site. These routes
        // are mounted whether or not a provider is configured; disabling them
        // answers 404 over HTTP.
        disabledPaths: ['/get-access-token', '/refresh-token', '/account-info'],
        // OAuth failures with no flow-specific error URL (a forged or replayed
        // state) land on the site's login page, not Better Auth's own.
        onAPIError: { errorURL: '/login' },
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
