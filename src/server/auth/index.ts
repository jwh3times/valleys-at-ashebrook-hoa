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

export function createAuth(env?: Env, cf?: IncomingRequestCfProperties, baseURL?: string) {
  return betterAuth({
    baseURL: baseURL ?? env?.BETTER_AUTH_URL,
    secret: env?.BETTER_AUTH_SECRET,
    ...withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: false,
        // Cast to CloudflareGeolocation — IncomingRequestCfProperties is a superset;
        // an empty object satisfies the check that cf is truthy (required when
        // autoDetectIpAddress is true).
        cf: (cf ?? {}) as CloudflareGeolocation,
        // Use a plain drizzle(D1) instance (no schema) for better-auth's adapter —
        // better-auth manages its own schema definitions; the schema arg is not needed here.
        d1: env ? { db: drizzle(env.DATABASE), options: { usePlural: true } } : undefined,
        kv: env?.KV,
      },
      {
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: true,
          minPasswordLength: 10,
          sendResetPassword: async ({ user, url }) => {
            if (!env) return;
            await sendEmail(env, user.email, 'Reset your HOA password', `Reset link: ${url}`);
          },
        },
        emailVerification: {
          sendVerificationEmail: async ({ user, url }) => {
            if (!env) return;
            await sendEmail(env, user.email, 'Verify your HOA account', `Verify link: ${url}`);
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
