import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

// Temporary minimal config for CLI schema generation only.
// Task 3 replaces this with the full Cloudflare runtime config.
export const auth = betterAuth({
  database: drizzleAdapter({} as never, {
    provider: 'sqlite',
    usePlural: true,
  }),
  emailAndPassword: { enabled: true },
  plugins: [admin()],
});
