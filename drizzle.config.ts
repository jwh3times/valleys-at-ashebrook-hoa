import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  // Two files on purpose: `schema.ts` is the shipped model, `roster-schema.ts`
  // is the ADR 0022 party roster, which nothing reads until phase 2. Keeping
  // them separate keeps either reviewable, and avoids a cycle — roster-schema
  // imports from schema, never the reverse.
  schema: [
    './src/server/db/schema.ts',
    './src/server/db/roster-schema.ts',
    './src/server/db/audit-schema.ts',
    './src/server/db/cutover-schema.ts',
  ],
  out: './src/server/db/migrations',
});
