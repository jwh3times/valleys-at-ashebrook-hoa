import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings, properties } from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  contactMethods,
  ownerships,
} from '../../src/server/db/roster-schema';
import { legacyAuthContext } from '../../src/server/authz/context';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  fetchAdminRoster,
  type MemberRosterSelf,
} from '../../src/server/roster/reads';
import { personDisplayLabel } from '../../src/lib/format';
import { GET } from '../../src/pages/api/member/roster-self';

/**
 * #218's member self-read: a homeowner's own Person, Contact Methods,
 * Ownerships, Representations, and open correction requests — the ONLY
 * roster surface a member reaches directly (see `correction-requests.test.ts`
 * for the request/accept flow). `fetchMemberRosterSelf`
 * (src/server/roster/reads.ts) does the real work; this pins the route's
 * gate, its one deliberate non-masked 403, and the shared-`personDisplayLabel`
 * parity #218 requires between the member and board reads of a redacted name.
 */

const DAY = '2026-08-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const NEW_TABLES = ['ownerships', 'contact_methods', 'people', 'parties'];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of NEW_TABLES) {
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw('DELETE FROM properties'));
  await db.run(sql.raw('DELETE FROM users'));
  await db.delete(settings).where(eq(settings.key, 'site'));
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    updatedAt: new Date(),
  });
});

async function seedAccount(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedLot(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Ashebrook Lane`,
      addressNormalized: `${id} ashebrook lane`,
      status: 'active',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedPerson(id: string, fullName: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env).insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName,
    nameNormalized: fullName.toLowerCase(),
    updatedAt: now,
  });
}

async function redactPerson(id: string) {
  await getDb(env).run(
    sql`UPDATE people SET full_name = NULL, name_normalized = NULL, name_redacted_at = ${Date.now()} WHERE party_id = ${id}`,
  );
}

async function seedContactMethod(id: string, partyId: string) {
  const now = new Date();
  await getDb(env)
    .insert(contactMethods)
    .values({
      id,
      partyId,
      channel: 'email',
      value: `${id}@example.test`,
      valueNormalized: `${id}@example.test`,
      isPreferred: true,
      startDay: null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedOwnership(id: string, partyId: string, lotId: string) {
  const now = new Date();
  await getDb(env).insert(ownerships).values({
    id,
    ownerPartyId: partyId,
    lotId,
    startDay: null,
    createdAt: now,
    updatedAt: now,
  });
}

function memberCtx(
  userId: string,
  personId: string,
  lotIds: string[] = [],
): AuthContext {
  return {
    userId,
    personId,
    capabilities: new Set(['member']),
    lotIds,
    contentTier: 'homeowner',
    hasCurrentBoardTerm: false,
    role: 'homeowner',
    propertyIds: lotIds,
  };
}

function memberReq(ctx: AuthContext | null) {
  return {
    request: new Request('http://localhost/api/member/roster-self', {
      method: 'GET',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
    }),
    locals: { authContext: ctx },
  } as never;
}

describe('GET /api/member/roster-self', () => {
  it("returns the caller's own person, contacts, and ownerships", async () => {
    await seedAccount('mem-1');
    await seedLot('lot-1');
    await seedPerson('per-1', 'Jamie Resident');
    await seedContactMethod('cm-1', 'per-1');
    await seedOwnership('own-1', 'per-1', 'lot-1');

    const res = await GET(memberReq(memberCtx('mem-1', 'per-1', ['lot-1'])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemberRosterSelf;
    expect(body.person).toEqual({
      partyId: 'per-1',
      displayName: 'Jamie Resident',
      nameRedacted: false,
    });
    expect(body.contactMethods).toHaveLength(1);
    expect(body.contactMethods[0]).toMatchObject({
      id: 'cm-1',
      channel: 'email',
      value: 'cm-1@example.test',
      redacted: false,
    });
    expect(body.ownerships).toHaveLength(1);
    expect(body.ownerships[0]).toMatchObject({
      id: 'own-1',
      lotId: 'lot-1',
      lotAddress: 'lot-1 Ashebrook Lane',
    });
    expect(body.openRequests).toEqual([]);
  });

  it('403s with a verification message when the caller has no linked Person', async () => {
    await seedAccount('mem-2');
    // legacyAuthContext always sets personId: null — the shape every caller
    // has under cutover_mode = legacy, since legacy has no Person concept.
    const res = await GET(
      memberReq(legacyAuthContext('mem-2', 'homeowner', [])),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(
      'Your account is not linked to a resident record — complete verification first.',
    );
  });

  it('never returns 401/404 for the not-linked case — it is a 403, not a masked absence', async () => {
    await seedAccount('mem-2b');
    const res = await GET(
      memberReq(legacyAuthContext('mem-2b', 'homeowner', [])),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("renders a redacted person's displayName identically to the admin roster read", async () => {
    // src/pages/api/admin/roster.ts — the #218 admin roster GET route — is a
    // sibling phase-3b slice's file and does not exist in this worktree yet.
    // Every existing admin route follows one shape (`requireBoard` +
    // `Response.json(await fetchXxx(env))`, e.g. proxies.ts / roster-preview.ts),
    // so once it lands it will simply wrap `fetchAdminRoster` the same way this
    // asserts against directly. Both reduce to the identical `personDisplayLabel`
    // call, so this pins the #218 acceptance criterion — the redacted-name
    // fallback "renders identically for a board caller and a member caller" —
    // without a hard import dependency on a route another agent may not have
    // created yet. Swap this for a direct GET-route comparison once roster.ts
    // exists.
    await seedAccount('mem-3');
    await seedPerson('per-3', 'Redact Me');
    await redactPerson('per-3');

    const res = await GET(memberReq(memberCtx('mem-3', 'per-3')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemberRosterSelf;
    expect(body.person.nameRedacted).toBe(true);
    expect(body.person.displayName).toBe(personDisplayLabel(null, 'per-3'));

    const adminRoster = await fetchAdminRoster(env, DAY);
    const adminPerson = adminRoster.people.find((p) => p.partyId === 'per-3');
    expect(adminPerson).toBeDefined();
    expect(adminPerson!.nameRedacted).toBe(true);
    expect(body.person.displayName).toBe(adminPerson!.displayName);
  });
});
