// Page-level (integration) tests for the public elections page, rendered
// through the real Astro Container API inside the actual Workers runtime (via
// @cloudflare/vitest-pool-workers) — see meeting-pages.test.ts for why this
// setup is needed (`import { env } from 'cloudflare:workers'` in the page
// must resolve exactly as it does in production).
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import * as fx from './fixtures';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import { settings } from '../../src/server/db/schema';
import {
  personLinks,
  personVerifications,
} from '../../src/server/db/roster-schema';

import { fetchAdminElections } from '../../src/server/content/reads';
import ElectionsPage from '../../src/pages/elections.astro';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  // Not cleared by truncateAll: the roster link tables the receipt derives the
  // caller's lots from, and the accounts they hang off.
  for (const table of [
    'person_links',
    'person_verifications',
    'access_grants',
    'board_service_terms',
    'ownerships',
  ])
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  await fx.truncateAll();
  await db.run(sql.raw('DELETE FROM users'));
  await db.insert(users).values({
    id: 'acct-1',
    name: 'acct-1',
    email: 'acct-1@example.test',
    emailVerified: true,
    createdAt: fx.now,
    updatedAt: fx.now,
  });
});

/** A verified Person Link, which is what makes LOT_SQL answer at all. */
async function linkAccount(accountId: string, personId: string) {
  const db = getDb(env);
  await db.insert(personVerifications).values({
    id: `ver-${accountId}`,
    accountId,
    personId,
    method: 'manual',
    approverAccountId: accountId,
    reason: 'manual_board_decision',
    verifiedAt: fx.now,
  });
  await db.insert(personLinks).values({
    id: `link-${accountId}`,
    accountId,
    personId,
    verificationId: `ver-${accountId}`,
    startedAt: fx.now,
  });
}

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  return container;
}

const seedElection = fx.seedElection;

const seedCandidate = fx.seedCandidate;

const seedProperty = fx.seedProperty;

const seedBallot = fx.seedBallot;

/**
 * #302: the page now asks `ctx.capabilities`, so a signed-in caller's locals
 * must carry a real capability Set. `member` is the default for a signed-in
 * caller because that is what a verified homeowner has; the receipt tests
 * below override it to cover the callers who must see nothing.
 */
function localsFor(
  role: 'visitor' | 'homeowner' | 'board',
  overrides: {
    capabilities?: string[];
    lotIds?: string[];
    personId?: string | null;
  } = {},
) {
  if (role === 'visitor') return undefined;
  const capabilities = overrides.capabilities ?? [
    'member',
    ...(role === 'board' ? ['board'] : []),
  ];
  return {
    authContext: {
      userId: 'acct-1',
      personId: overrides.personId === undefined ? 'per-1' : overrides.personId,
      capabilities: new Set(capabilities),
      lotIds: overrides.lotIds ?? [],
      contentTier: role,
      hasCurrentBoardTerm: false,
      role,
    },
  } as unknown as App.Locals;
}

function renderAs(
  container: Awaited<ReturnType<typeof makeContainer>>,
  role: 'visitor' | 'homeowner' | 'board',
  url = 'http://localhost/elections',
  overrides?: Parameters<typeof localsFor>[1],
) {
  return container.renderToString(ElectionsPage, {
    request: new Request(url),
    locals: localsFor(role, overrides),
  });
}

/** Same render, as a Response, so the cache header can be asserted. */
function responseAs(
  container: Awaited<ReturnType<typeof makeContainer>>,
  role: 'visitor' | 'homeowner' | 'board',
  overrides?: Parameters<typeof localsFor>[1],
) {
  return container.renderToResponse(ElectionsPage, {
    request: new Request('http://localhost/elections'),
    locals: localsFor(role, overrides),
  });
}

describe('/elections', () => {
  it('renders a certified election for a visitor', async () => {
    await seedElection('e1', {
      status: 'certified',
      visibility: 'public',
      title: 'Board Election 2026',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('Residents Association Elections');
    expect(html).toContain('Board Election 2026');
  });

  it('never renders a draft election, even for a board caller', async () => {
    await seedElection('draft1', {
      status: 'draft',
      visibility: 'board',
      title: 'Not Yet Held Election',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'board');
    expect(html).not.toContain('Not Yet Held Election');
  });

  it('never renders a void election, even for a board caller', async () => {
    await seedElection('void1', {
      status: 'void',
      visibility: 'board',
      title: 'Abandoned Election',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'board');
    expect(html).not.toContain('Abandoned Election');
  });

  it('does not render a board-visibility election for a homeowner', async () => {
    await seedElection('boardonly', {
      status: 'certified',
      visibility: 'board',
      title: 'Board Only Election',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).not.toContain('Board Only Election');
  });

  it('never shows the per-lot ballot list, for any role — with a positive control against the admin read', async () => {
    await seedElection('e1', {
      status: 'certified',
      visibility: 'public',
      title: 'Ballot Secrecy Election',
    });
    await seedProperty('p1', { address: '111 Secret Ballot Lane' });
    await seedBallot('b1', 'e1', 'p1');

    const container = await makeContainer();

    // Regression insurance against a call-site swap (e.g. back to
    // fetchAdminElections) — NOT proof the page masks ballots correctly, since
    // fetchElectionsFor already returns `ballots: null` at the read layer
    // (reads.ts) before the page ever sees this election. A page that never
    // touched `ballots` at all would still pass every one of these for any
    // role, which is exactly why the positive control below exists.
    for (const role of ['visitor', 'homeowner', 'board'] as const) {
      const html = await renderAs(container, role);
      expect(html).not.toContain('111 Secret Ballot Lane');
    }

    // Positive control: the SAME fixture's address is real and DOES appear on
    // the admin read (fetchAdminElections, called directly here, never from
    // the public page). This proves the assertions above are the absence of a
    // present value — a fixture that would render for someone entitled to see
    // it — not the absence of an empty fixture.
    const adminRows = await fetchAdminElections(env);
    const adminE1 = adminRows.find((r) => r.id === 'e1');
    expect(adminE1?.ballots).toEqual([
      {
        propertyId: 'p1',
        address: '111 Secret Ballot Lane',
        weight: 1,
        viaProxy: false,
        castByPersonId: null,
        proxyId: null,
      },
    ]);
  });

  it('renders aggregate turnout as lots and vote weight, both denominators distinct from each other', async () => {
    await seedElection('e1', { status: 'certified', visibility: 'public' });
    // Two active lots with different weights (1 and 3 -> eligibleWeight 4,
    // eligibleCount 2) so a mutation that swapped the count/weight
    // denominators, or used eligibleWeight as the lot denominator, would be
    // caught rather than accidentally passing.
    await seedProperty('p1', { voteWeight: 1 });
    await seedProperty('p2', { voteWeight: 3 });
    await seedBallot('b1', 'e1', 'p1', { weight: 1 });

    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('1 of 2 lots');
    expect(html).toContain('1 of 4 vote weight');
  });

  it('renders a null tally as "not recorded", never as zero', async () => {
    await seedElection('e1', { status: 'certified', visibility: 'public' });
    await seedCandidate('c-null', 'e1', {
      sequence: 1,
      fullName: 'No Tally Yet',
      votes: null,
    });
    await seedCandidate('c-zero', 'e1', {
      sequence: 2,
      fullName: 'Recorded Zero',
      votes: 0,
    });

    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('No Tally Yet');
    expect(html).toContain('not recorded');
    expect(html).toContain('Recorded Zero');
    // The zero-vote candidate must show an actual 0, not fall into the same
    // "not recorded" bucket as the null one.
    expect(html).not.toMatch(/Recorded Zero[\s\S]{0,80}not recorded/);
  });

  it('marks winners', async () => {
    await seedElection('e1', { status: 'certified', visibility: 'public' });
    await seedCandidate('c-won', 'e1', {
      sequence: 1,
      fullName: 'Winning Candidate',
      votes: 40,
      won: true,
    });
    await seedCandidate('c-lost', 'e1', {
      sequence: 2,
      fullName: 'Losing Candidate',
      votes: 10,
      won: false,
    });

    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('Winning Candidate');
    expect(html).toContain('Losing Candidate');
    // Rough positional check: the winner badge text appears, and closer to
    // the winning candidate's name than to the losing one's.
    const wonIdx = html.indexOf('Winning Candidate');
    const lostIdx = html.indexOf('Losing Candidate');
    const badgeIdx = html.indexOf('Winner', wonIdx);
    expect(badgeIdx).toBeGreaterThan(-1);
    expect(badgeIdx).toBeLessThan(lostIdx);
  });

  it('labels a withdrawn candidate', async () => {
    await seedElection('e1', { status: 'certified', visibility: 'public' });
    await seedCandidate('c-out', 'e1', {
      sequence: 1,
      fullName: 'Withdrawn Candidate',
      withdrawn: true,
    });

    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('Withdrawn Candidate');
    expect(html).toContain('Withdrawn');
  });
});

/**
 * #302 / ADR 0026: the paper-ballot receipt. A lot's own holders on the
 * election date may see whether that lot is recorded as having returned a
 * ballot — never what it said, and never anything about another lot.
 */
describe('/elections paper ballot receipt', () => {
  const ELECTION_DAY = '2026-03-01';

  async function seedHeldLotElection(
    overrides: Record<string, unknown> = {},
    withBallot = true,
  ) {
    await seedProperty('lot-1');
    await fx.seedLotAuthority('per-1', 'lot-1', { startDay: '2025-01-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
      title: 'Paper Election 2026',
      ...overrides,
    });
    if (withBallot) await seedBallot('b1', 'e1', 'lot-1');
  }

  it('tells a holder their lot is recorded as having returned a ballot', async () => {
    await seedHeldLotElection();
    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).toContain("Your lot's ballot");
    expect(html).toContain(
      'Your ballot for lot-1 Ashebrook Lane is recorded as returned',
    );
  });

  it('tells a holder with no record how to dispute it', async () => {
    // A register the board HAS keyed — another lot returned one.
    await seedProperty('lot-2');
    await seedHeldLotElection({}, false);
    await seedBallot('b2', 'e1', 'lot-2');

    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).toContain('No ballot is recorded for lot-1 Ashebrook Lane');
    expect(html).toContain('href="/contact"');
    // The neighbour's participation never surfaces.
    expect(html).not.toContain('lot-2 Ashebrook Lane');
  });

  it('says the register is not entered yet rather than "not recorded"', async () => {
    await seedHeldLotElection({}, false);
    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).toContain(
      "The board has not entered this election's ballot register yet",
    );
    expect(html).not.toContain('No ballot is recorded');
  });

  it('adds the uncertify note on a certified election with no record', async () => {
    await seedProperty('lot-2');
    await seedHeldLotElection({ status: 'certified' }, false);
    await seedBallot('b2', 'e1', 'lot-2');

    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).toContain('No ballot is recorded for lot-1 Ashebrook Lane');
    expect(html).toContain('requires the board to uncertify it first');
  });

  it('shows a neutral line to a member who held no lot on that date', async () => {
    await seedProperty('lot-1');
    // Bought after the election, so no authority on the day.
    await fx.seedLotAuthority('per-1', 'lot-1', { startDay: '2026-06-01' });
    await linkAccount('acct-1', 'per-1');
    await seedElection('e1', {
      electionDate: ELECTION_DAY,
      status: 'closed',
      visibility: 'public',
    });
    await seedBallot('b1', 'e1', 'lot-1');

    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).toContain("You held no lot on this election's date");
    expect(html).not.toContain('is recorded as returned');
  });

  describe('who gets the block at all', () => {
    it('shows nothing to an anonymous visitor', async () => {
      await seedHeldLotElection();
      const container = await makeContainer();
      const html = await renderAs(container, 'visitor');
      expect(html).toContain('Paper Election 2026');
      expect(html).not.toContain("Your lot's ballot");
    });

    it('shows nothing to a signed-in account with no member capability', async () => {
      await seedHeldLotElection();
      const container = await makeContainer();
      // An unlinked account, a board admin who holds no lot, and a System
      // Administrator who holds no lot all look like this: no `member`.
      for (const capabilities of [[], ['board'], ['board', 'systemAdmin']]) {
        const html = await renderAs(container, 'board', undefined, {
          capabilities,
          personId: null,
        });
        expect(html).toContain('Paper Election 2026');
        expect(html).not.toContain("Your lot's ballot");
      }
    });

    it('shows the block to a board caller who does hold a lot', async () => {
      await seedHeldLotElection();
      const container = await makeContainer();
      const html = await renderAs(container, 'board');
      expect(html).toContain(
        'Your ballot for lot-1 Ashebrook Lane is recorded as returned',
      );
    });
  });

  it('marks a caller-specific render private and uncacheable', async () => {
    await seedHeldLotElection();
    const container = await makeContainer();

    const member = await responseAs(container, 'homeowner');
    expect(member.headers.get('Cache-Control')).toBe('private, no-store');

    // The public render is untouched, so a zone cache rule stays viable.
    const visitor = await responseAs(container, 'visitor');
    expect(visitor.headers.get('Cache-Control')).not.toBe('private, no-store');
  });

  it('renders with officialMode and liveVotingEnabled both off', async () => {
    await seedHeldLotElection();
    await getDb(env)
      .insert(settings)
      .values({
        key: 'site',
        value: JSON.stringify({
          officialMode: false,
          liveVotingEnabled: false,
        }),
        updatedAt: fx.now,
      });

    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    // Decision 2: neither flag gates this read. Live voting gates CONDUCTED
    // voting, which a paper election never is, and official mode gates
    // homeowner WRITES. A later edit that gates it would fail here.
    expect(html).toContain(
      'Your ballot for lot-1 Ashebrook Lane is recorded as returned',
    );
  });

  for (const status of ['draft', 'void'] as const) {
    it(`renders no receipt for a ${status} election the caller holds a lot in`, async () => {
      await seedHeldLotElection({ status, title: `Hidden ${status}` });
      const container = await makeContainer();
      const html = await renderAs(container, 'homeowner');
      expect(html).not.toContain(`Hidden ${status}`);
      expect(html).not.toContain("Your lot's ballot");
    });
  }
});
