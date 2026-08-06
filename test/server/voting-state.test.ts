import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { getDb } from '../../src/server/db/client';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await env.DATABASE.prepare("DELETE FROM settings WHERE key = 'site'").run();
});

async function predicateResults(): Promise<[number, number]> {
  const { LIVE_VOTING_ENABLED_SQL, liveVotingEnabledInDb } =
    await import('../../src/server/content/voting-state');
  const raw = await env.DATABASE.prepare(
    `SELECT (${LIVE_VOTING_ENABLED_SQL}) AS enabled`,
  ).first<{ enabled: number }>();
  const drizzle = await getDb(env).get<{ enabled: number }>(
    sql`SELECT ${liveVotingEnabledInDb} AS enabled`,
  );
  return [Number(raw?.enabled), Number(drizzle?.enabled)];
}

async function setSiteValue(value: string): Promise<void> {
  await env.DATABASE.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, ?)",
  )
    .bind(value, Math.floor(Date.now() / 1000))
    .run();
}

describe('live voting database predicate', () => {
  it('fails closed when the site setting is missing', async () => {
    expect(await predicateResults()).toEqual([0, 0]);
  });

  it('fails closed when the site setting contains malformed JSON', async () => {
    await setSiteValue('{not-json');
    expect(await predicateResults()).toEqual([0, 0]);
  });

  it('requires both official mode and live voting to be true', async () => {
    await setSiteValue(
      JSON.stringify({ officialMode: true, liveVotingEnabled: false }),
    );
    expect(await predicateResults()).toEqual([0, 0]);
  });

  it('is true only when official mode and live voting are both true', async () => {
    await setSiteValue(
      JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    );
    expect(await predicateResults()).toEqual([1, 1]);
  });
});
