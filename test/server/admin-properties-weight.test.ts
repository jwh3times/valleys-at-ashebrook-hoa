import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('b', 'board', []),
}));

import { POST, PATCH } from '../../src/pages/api/admin/properties';
import { getDb } from '../../src/server/db/client';
import { properties } from '../../src/server/db/schema';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(properties);
});

function req(url: string, method: string, body?: unknown) {
  return {
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

const url = 'http://localhost/api/admin/properties';

async function rowByAddress(address: string) {
  const [row] = await getDb(env)
    .select()
    .from(properties)
    .where(eq(properties.address, address));
  return row;
}

describe('property vote weight — board', () => {
  it('creating a home without voteWeight defaults to 1', async () => {
    const res = await POST(req(url, 'POST', { address: '1 Default Way' }));
    expect(res.status).toBe(201);
    const row = await rowByAddress('1 Default Way');
    expect(row).toBeTruthy();
    expect(row.voteWeight).toBe(1);
  });

  it('creating a home with voteWeight 3 stores 3', async () => {
    const res = await POST(
      req(url, 'POST', { address: '2 Weighted Ln', voteWeight: 3 }),
    );
    expect(res.status).toBe(201);
    const row = await rowByAddress('2 Weighted Ln');
    expect(row).toBeTruthy();
    expect(row.voteWeight).toBe(3);
  });

  it('patching a home changes its voteWeight', async () => {
    await POST(req(url, 'POST', { address: '3 Patch Ct' }));
    const created = await rowByAddress('3 Patch Ct');
    const res = await PATCH(
      req(url, 'PATCH', { id: created.id, voteWeight: 5 }),
    );
    expect(res.status).toBe(204);
    const row = await rowByAddress('3 Patch Ct');
    expect(row.voteWeight).toBe(5);
  });

  it('rejects voteWeight: 0 on create with 400', async () => {
    const res = await POST(
      req(url, 'POST', { address: '4 Zero Ave', voteWeight: 0 }),
    );
    expect(res.status).toBe(400);
    const row = await rowByAddress('4 Zero Ave');
    expect(row).toBeUndefined();
  });

  it('rejects voteWeight: 0 on patch with 400 and leaves the stored value unchanged', async () => {
    await POST(req(url, 'POST', { address: '5 Stays One', voteWeight: 2 }));
    const created = await rowByAddress('5 Stays One');
    const res = await PATCH(
      req(url, 'PATCH', { id: created.id, voteWeight: 0 }),
    );
    expect(res.status).toBe(400);
    const row = await rowByAddress('5 Stays One');
    expect(row.voteWeight).toBe(2);
  });
});
