import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import type { AuthContext, Capability } from '../../src/server/authz/guards';

/**
 * The permission matrix (#206): every route's DECLARED capability, asserted
 * against every caller class.
 *
 * This is not the same claim as `admin-routes-all-gated.test.ts`, which proves
 * each route rejects an anonymous caller. That leaves the interesting half
 * unproven — a route could reject anonymous and still admit a member, and
 * nothing would notice. This asserts what each surface actually requires.
 *
 * Per #206 it OUTLIVES the migration. It is not scaffolding for the flip; it is
 * the invariant the flip exists to preserve, so phase 4 keeps it.
 *
 * Callers are built as capability sets directly rather than through
 * `legacyAuthContext`, because the matrix is a statement about capabilities.
 * Which model produced them is `cutover_mode`'s business, and the gates cannot
 * tell the difference — which is precisely the property that makes the flip a
 * flag change.
 */

const MEMBER_ROUTES = import.meta.glob('../../src/pages/api/member/**/*.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>;
// Recursive on purpose, unlike admin-routes-all-gated's flat glob: a route
// added in a subdirectory tomorrow must land in this matrix without anyone
// remembering it exists.
const ADMIN_ROUTES = import.meta.glob('../../src/pages/api/admin/**/*.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>;
const VOTE_ROUTE = import.meta.glob('../../src/pages/api/vote.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>;

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    updatedAt: new Date(),
  });
});

function caller(id: string, ...capabilities: Capability[]): AuthContext {
  const set = new Set<Capability>(capabilities);
  const contentTier = set.has('board')
    ? 'board'
    : set.has('member')
      ? 'homeowner'
      : 'visitor';
  return {
    userId: id,
    personId: `person-${id}`,
    capabilities: set,
    lotIds: set.has('member') ? ['lot-1'] : [],
    contentTier,
    hasCurrentBoardTerm: set.has('board'),
    role: contentTier,
    propertyIds: set.has('member') ? ['lot-1'] : [],
  };
}

/** The caller classes #206 names, minus anonymous (which has no context). */
const MEMBER_ONLY = caller('m', 'member');
const BOARD = caller('b', 'board', 'member');
/** A board member who owns nothing — the class the old ladder handled wrong. */
const BOARD_NO_LOTS = caller('bn', 'board');
/** Carries the four technical capabilities exactly as derivation grants them
 * with the `system_admin` grant (#205) — they are names for that boundary,
 * never separate grants. */
const SYSTEM_ADMIN = caller(
  'sa',
  'systemAdmin',
  'board',
  'redactionAuthorize',
  'redactionCleanup',
  'accessDenialDetail',
  'auditIntegrityViews',
);
/** Authenticated, linked to nothing. Under derived authorization this is 403. */
const UNLINKED = caller('u');

/**
 * Admin routes whose DECLARED capability is finer than `board`: the
 * System-Administrator-only technical surfaces (#205, #218). Plain board is
 * refused here — the one boundary finer than board that actually exists.
 */
const SYSTEM_ADMIN_ONLY = new Set([
  'admin/redactions',
  'admin/access-denials',
  'admin/audit-integrity',
]);

function cases(modules: Record<string, Record<string, unknown>>) {
  const out: { name: string; route: string; verb: string; handler: unknown }[] =
    [];
  for (const [path, mod] of Object.entries(modules)) {
    const route = `/api/${path.split('/src/pages/api/')[1]?.replace(/\.ts$/, '')}`;
    for (const verb of VERBS) {
      if (typeof mod[verb] === 'function')
        out.push({
          name: route.replace('/api/', ''),
          route,
          verb,
          handler: mod[verb],
        });
    }
  }
  return out;
}

/**
 * Sentinel for "the gate admitted this caller and the route then failed on the
 * empty body".
 *
 * Requests carry no body on purpose — every gate must run before any body read,
 * which is what `admin-routes-all-gated.test.ts` relies on too. For an admitted
 * caller that means some routes throw while parsing instead of returning a
 * status. That throw is evidence of admission — execution reached the route's
 * own logic — and treating it as a status keeps the assertions uniform.
 */
const ADMITTED_THEN_THREW = 599;

async function callWith(
  handler: unknown,
  route: string,
  verb: string,
  ctx: AuthContext | null,
): Promise<number> {
  try {
    const res = await (handler as (c: unknown) => Promise<Response>)({
      request: new Request(`http://localhost${route}`, {
        method: verb,
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
      }),
      locals: { authContext: ctx },
    });
    return res.status;
  } catch (error) {
    // Admission evidence must be POSITIVE. The guards return Responses and
    // never throw for a denial, so the only throws this sentinel may absorb
    // are the empty-body parse failures a route hits AFTER its gate: JSON
    // (SyntaxError) or formData (a TypeError naming FormData). Anything else —
    // a D1 failure inside a guard, a malformed context — is an unknown state
    // and fails the test loudly. A security matrix whose unknown outcome
    // scores as "admitted" would itself be fail-open.
    if (
      error instanceof SyntaxError ||
      (error instanceof TypeError && String(error).includes('FormData'))
    )
      return ADMITTED_THEN_THREW;
    throw error;
  }
}

describe('the admin API declares board', () => {
  const all = cases(ADMIN_ROUTES);

  it('found the admin routes', () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
  });

  for (const { name, route, verb, handler } of all) {
    if (SYSTEM_ADMIN_ONLY.has(name)) {
      it(`${name} ${verb} admits only a System Administrator`, async () => {
        expect(
          await callWith(handler, route, verb, MEMBER_ONLY),
          `${name} ${verb} must refuse a member-only caller`,
        ).toBe(403);
        expect(
          await callWith(handler, route, verb, UNLINKED),
          `${name} ${verb} must refuse an unlinked caller`,
        ).toBe(403);
        // The whole point of the finer declaration: plain board is refused.
        expect(
          await callWith(handler, route, verb, BOARD),
          `${name} ${verb} must refuse plain board`,
        ).toBe(403);
        expect(
          [401, 403].includes(
            await callWith(handler, route, verb, SYSTEM_ADMIN),
          ),
          `${name} ${verb} must admit a System Administrator`,
        ).toBe(false);
      });
      continue;
    }
    it(`${name} ${verb} admits board and refuses member`, async () => {
      expect(
        await callWith(handler, route, verb, MEMBER_ONLY),
        `${name} ${verb} must refuse a member-only caller`,
      ).toBe(403);
      expect(
        await callWith(handler, route, verb, UNLINKED),
        `${name} ${verb} must refuse an unlinked caller`,
      ).toBe(403);
      // Board passes the GATE. What it does next is the route's business, so
      // assert only that it was not an authorization refusal.
      expect(
        [401, 403].includes(await callWith(handler, route, verb, BOARD)),
        `${name} ${verb} must admit board`,
      ).toBe(false);
    });
  }

  it('admits a board member who owns no Lot', async () => {
    // Board capability comes from a grant, never from Lot Authority. A board
    // member who owns nothing must still reach the admin API.
    const { route, verb, handler } = all[0];
    expect([401, 403]).not.toContain(
      await callWith(handler, route, verb, BOARD_NO_LOTS),
    );
  });

  it('admits a System Administrator, who carries board', async () => {
    const { route, verb, handler } = all[0];
    expect([401, 403]).not.toContain(
      await callWith(handler, route, verb, SYSTEM_ADMIN),
    );
  });
});

describe('the homeowner-write API declares member', () => {
  const all = [...cases(MEMBER_ROUTES), ...cases(VOTE_ROUTE)];

  it('found the member and voting routes', () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  for (const { name, route, verb, handler } of all) {
    it(`${name} ${verb} admits member and refuses an unlinked caller`, async () => {
      expect(
        await callWith(handler, route, verb, UNLINKED),
        `${name} ${verb} must refuse an unlinked caller`,
      ).toBe(403);
      expect(
        [401, 403].includes(await callWith(handler, route, verb, MEMBER_ONLY)),
        `${name} ${verb} must admit a member`,
      ).toBe(false);
    });

    it(`${name} ${verb} refuses a board member who owns no Lot`, async () => {
      // THE named behavior change of derived authorization, and one of exactly
      // two entries on #206's explained-mismatch allow-list. Board capability
      // is not Lot Authority; the old rank ladder conflated them and this is
      // where that stops.
      //
      // Under `cutover_mode = legacy` this caller cannot occur — legacy
      // synthesis gives every board caller `member` — so this asserts the
      // capability semantics rather than a live legacy behavior.
      expect(
        await callWith(handler, route, verb, BOARD_NO_LOTS),
        `${name} ${verb} must refuse board-without-Lots`,
      ).toBe(403);
    });
  }
});
