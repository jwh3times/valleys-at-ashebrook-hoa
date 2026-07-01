import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getDb(env: Env) {
  return drizzle(env.DATABASE, { schema });
}

export type Db = ReturnType<typeof getDb>;
