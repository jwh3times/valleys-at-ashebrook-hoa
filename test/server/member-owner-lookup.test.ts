import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST } from '../../src/pages/api/member/owner-lookup';
import { getDb } from '../../src/server/db/client';
import { settings, properties, owners } from '../../src/server/db/schema';
import type { AuthContext } from '../../src/server/authz/guards';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(owners);
  await db.delete(properties);
  await db.delete(settings).where(eq(settings.key, 'site'));
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true }),
    updatedAt: now,
  });
  await db.insert(properties).values({
    id: 'p2',
    address: '2 Oak St.',
    addressNormalized: '2 oak st',
    voteWeight: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(owners).values([
    {
      id: 'o2',
      propertyId: 'p2',
      fullName: 'John Roe',
      phone: '+15550001111',
      email: 'john@example.com',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'o2b',
      propertyId: 'p2',
      fullName: 'Gone Owner',
      status: 'inactive',
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

const jane: AuthContext = {
  userId: 'u1',
  role: 'homeowner',
  propertyIds: ['p1'],
};

function call(ctx: AuthContext | null, body?: unknown) {
  return POST({
    request: new Request('http://localhost/api/member/owner-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    locals: { authContext: ctx } as unknown as App.Locals,
  } as never);
}

describe('POST /api/member/owner-lookup', () => {
  it("returns the matched lot's ACTIVE owner names and ids only — no phone, no email", async () => {
    const res = await call(jane, { address: '2 Oak St' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      propertyId: 'p2',
      address: '2 Oak St.',
      owners: [{ id: 'o2', fullName: 'John Roe' }],
    });
    // Belt and braces: the serialized payload must not carry contact data.
    expect(JSON.stringify(body)).not.toMatch(/555|example\.com/);
  });

  it('normalizes the queried address the same way the roster does', async () => {
    const res = await call(jane, { address: '  2 OAK st.  ' });
    expect(res.status).toBe(200);
  });

  it('404s an unknown address, 400s a blank or over-length one', async () => {
    expect((await call(jane, { address: '9 Nowhere Ln' })).status).toBe(404);
    expect((await call(jane, { address: '' })).status).toBe(400);
    expect((await call(jane, { address: 'x'.repeat(301) })).status).toBe(400);
    expect((await call(jane)).status).toBe(400);
  });
});
