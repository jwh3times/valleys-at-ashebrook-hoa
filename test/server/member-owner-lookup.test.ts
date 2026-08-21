import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST } from '../../src/pages/api/member/owner-lookup';
import { getDb } from '../../src/server/db/client';
import { settings, properties } from '../../src/server/db/schema';
import {
  parties,
  people,
  ownerships,
} from '../../src/server/db/roster-schema';
import type { AuthContext } from '../../src/server/authz/guards';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  // #248 part 2: ownerships reference both parties and properties with
  // RESTRICT, so the roster goes before the lots it points at.
  await db.delete(ownerships);
  await db.delete(people);
  await db.delete(parties);
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
  // #248 part 2: the lookup answers with the Persons who may act for the lot,
  // so these are roster Ownerships. 'o2b' is a FORMER holder — an ended
  // interval, where the legacy shape used owners.status — and must stay out of
  // the answer.
  await db.insert(parties).values([
    { id: 'o2', kind: 'person', createdAt: now, updatedAt: now },
    { id: 'o2b', kind: 'person', createdAt: now, updatedAt: now },
  ]);
  await db.insert(people).values([
    {
      partyId: 'o2',
      partyKind: 'person',
      fullName: 'John Roe',
      nameNormalized: 'john roe',
      updatedAt: now,
    },
    {
      partyId: 'o2b',
      partyKind: 'person',
      fullName: 'Gone Owner',
      nameNormalized: 'gone owner',
      updatedAt: now,
    },
  ]);
  await db.insert(ownerships).values([
    {
      id: 'o2-own',
      ownerPartyId: 'o2',
      lotId: 'p2',
      startDay: null,
      endDay: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'o2b-own',
      ownerPartyId: 'o2b',
      lotId: 'p2',
      startDay: null,
      endDay: '2020-01-01',
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

const jane: AuthContext = legacyAuthContext('u1', 'homeowner', ['p1']);

const staleJane: AuthContext = legacyAuthContext('u1', 'homeowner', []);

const board: AuthContext = legacyAuthContext('b1', 'board', []);

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
  it('403s a homeowner with no active lots before parsing the request body', async () => {
    const res = await call(staleJane);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
  });

  it('retains rank-based board access when the board caller has no lots', async () => {
    const res = await call(board, { address: '2 Oak St' });
    expect(res.status).toBe(200);
  });

  it("returns the Persons who may act for the matched lot, names and ids only — no phone, no email", async () => {
    const res = await call(jane, { address: '2 Oak St' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      propertyId: 'p2',
      address: '2 Oak St.',
      persons: [{ id: 'o2', fullName: 'John Roe' }],
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

  it('404s an inactive property identically to an unknown one, even with an active owner attached', async () => {
    const db = getDb(env);
    await db.insert(properties).values({
      id: 'p3',
      address: '3 Oak St.',
      addressNormalized: '3 oak st',
      status: 'inactive',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(parties)
      .values({ id: 'o3', kind: 'person', createdAt: now, updatedAt: now });
    await db.insert(people).values({
      partyId: 'o3',
      partyKind: 'person',
      fullName: 'Still Active Owner',
      nameNormalized: 'still active owner',
      updatedAt: now,
    });
    await db.insert(ownerships).values({
      id: 'o3-own',
      ownerPartyId: 'o3',
      lotId: 'p3',
      startDay: null,
      endDay: null,
      createdAt: now,
      updatedAt: now,
    });
    const unknown = await call(jane, { address: '9 Nowhere Ln' });
    const inactive = await call(jane, { address: '3 Oak St' });
    expect(inactive.status).toBe(404);
    expect(await inactive.text()).toBe(await unknown.text());
  });
});
