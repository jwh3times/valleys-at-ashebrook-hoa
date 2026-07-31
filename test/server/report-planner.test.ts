import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { vi } from 'vitest';

const captured: { planParams?: unknown } = {};
const planner = vi.hoisted(() => ({
  fail: false,
  text: '["leasing restrictions", "minimum lease term", "tenant approval"]',
}));
vi.mock('../../src/server/ai/anthropic', () => ({
  AssistantNotConfiguredError: class extends Error {},
  getAnthropic: () => ({
    messages: {
      create: async (params: unknown) => {
        captured.planParams = params;
        if (planner.fail) throw new Error('planner down');
        return { content: [{ type: 'text', text: planner.text }] };
      },
    },
  }),
}));

import { planSubQueries } from '../../src/server/ai/report';
import { loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';
import { getDb } from '../../src/server/db/client';
import { owners, properties } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(properties).values({
    id: 'p1',
    address: '123 Ashebrook Lane',
    addressNormalized: '123 ashebrook lane',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await getDb(env).insert(owners).values({
    id: 'o1',
    propertyId: 'p1',
    fullName: 'Jane Q Homeowner',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

async function pseud() {
  return buildPseudonymizer(await loadRosterEntries(env));
}

describe('planSubQueries', () => {
  it('returns the parsed queries from the planner', async () => {
    planner.fail = false;
    const queries = await planSubQueries(env, await pseud(), 'rentals');
    expect(queries).toEqual([
      'leasing restrictions',
      'minimum lease term',
      'tenant approval',
    ]);
  });

  it('pseudonymizes the topic before it reaches the planner', async () => {
    planner.fail = false;
    await planSubQueries(
      env,
      await pseud(),
      'complaints from Jane Q Homeowner',
    );
    expect(JSON.stringify(captured.planParams)).not.toContain(
      'Jane Q Homeowner',
    );
  });

  it('uses Haiku for the planning call', async () => {
    planner.fail = false;
    await planSubQueries(env, await pseud(), 'rentals');
    expect((captured.planParams as { model: string }).model).toBe(
      'claude-haiku-4-5',
    );
  });

  it('falls back to the raw topic when the planner call throws', async () => {
    planner.fail = true;
    try {
      const queries = await planSubQueries(env, await pseud(), 'solar panels');
      expect(queries).toEqual(['solar panels']);
    } finally {
      planner.fail = false;
    }
  });

  it('falls back to the raw topic on unparseable planner output', async () => {
    planner.text = 'sure! here are some queries';
    try {
      const queries = await planSubQueries(env, await pseud(), 'solar panels');
      expect(queries).toEqual(['solar panels']);
    } finally {
      planner.text = '["a", "b", "c"]';
    }
  });

  it('de-anonymizes surrogate names in returned queries so retrieval matches real text', async () => {
    const p = await pseud();
    const surrogate = p.anonymize('Jane Q Homeowner');
    planner.text = JSON.stringify([`letters from ${surrogate}`, 'b', 'c']);
    try {
      const queries = await planSubQueries(env, p, 'complaints');
      expect(queries[0]).toBe('letters from Jane Q Homeowner');
    } finally {
      planner.text = '["a", "b", "c"]';
    }
  });
});
