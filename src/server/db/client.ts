import { drizzle } from 'drizzle-orm/d1';
import * as appSchema from './schema';
import * as rosterSchema from './roster-schema';
import * as auditSchema from './audit-schema';
import * as cutoverSchema from './cutover-schema';

// The ADR 0022 tables are registered here from phase 1 so migrations and types
// stay coherent. Nothing reads them until phase 2 — see issue #195.
const schema = {
  ...appSchema,
  ...rosterSchema,
  ...auditSchema,
  ...cutoverSchema,
};

export function getDb(env: Env) {
  return drizzle(env.DATABASE, { schema });
}

export type Db = ReturnType<typeof getDb>;
