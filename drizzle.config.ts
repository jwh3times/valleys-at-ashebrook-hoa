import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
});
