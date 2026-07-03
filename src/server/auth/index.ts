import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { withCloudflare } from 'better-auth-cloudflare';
import type { CloudflareGeolocation } from 'better-auth-cloudflare';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { ac, visitor, homeowner, board } from './permissions';
import { sendEmail } from './senders';
import { SITE_NAME } from '../../lib/site';

export function createAuth(
  env?: Env,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  return betterAuth({
    baseURL: baseURL ?? env?.BETTER_AUTH_URL,
    secret: env?.BETTER_AUTH_SECRET,
    // Origins allowed to make auth requests. baseURL is trusted automatically;
    // list the custom domain (apex + www) and the workers.dev fallback explicitly
    // so sign-up/sign-in work no matter which host a visitor lands on.
    trustedOrigins: [
      'https://ashebrookresidents.com',
      'https://www.ashebrookresidents.com',
      'https://valleys-at-ashebrook-hoa.jerryholland00.workers.dev',
    ],
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
        kv: env?.KV,
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
    // Fallback database for the no-arg `auth` export (used by @better-auth/cli only).
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

// No-arg export for the Better Auth CLI (`npm run auth:generate`).
export const auth = createAuth();
