// Page-level (integration) tests for the public elections page, rendered
// through the real Astro Container API inside the actual Workers runtime (via
// @cloudflare/vitest-pool-workers) — see meeting-pages.test.ts for why this
// setup is needed (`import { env } from 'cloudflare:workers'` in the page
// must resolve exactly as it does in production).
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import { getDb } from '../../src/server/db/client';
import {
  elections,
  candidates,
  ballots,
  properties,
} from '../../src/server/db/schema';
import { fetchAdminElections } from '../../src/server/content/reads';
import ElectionsPage from '../../src/pages/elections.astro';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballots);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(properties);
});

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  return container;
}

async function seedElection(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(elections)
    .values({
      id,
      meetingId: null,
      title: `Election ${id}`,
      seats: 2,
      electionDate: '2026-09-14',
      source: 'recorded',
      status: 'closed',
      visibility: 'public',
      certifiedAt: null,
      certifiedBy: null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

async function seedCandidate(
  id: string,
  electionId: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(candidates)
    .values({
      id,
      electionId,
      fullName: `Candidate ${id}`,
      boardPersonId: null,
      statementMd: null,
      sequence: 0,
      votes: null,
      won: false,
      withdrawn: false,
      createdAt: now,
      ...overrides,
    });
}

async function seedProperty(
  id: string,
  overrides: Record<string, unknown> = {},
) {
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
      ...overrides,
    });
}

async function seedBallot(
  id: string,
  electionId: string,
  propertyId: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(ballots)
    .values({
      id,
      electionId,
      propertyId,
      weight: 1,
      castByOwnerId: null,
      recordedAt: now,
      ...overrides,
    });
}

function renderAs(
  container: Awaited<ReturnType<typeof makeContainer>>,
  role: 'visitor' | 'homeowner' | 'board',
  url = 'http://localhost/elections',
) {
  return container.renderToString(ElectionsPage, {
    request: new Request(url),
    locals:
      role === 'visitor'
        ? undefined
        : ({
            authContext: {
              userId: 'u',
              role,
              propertyIds: [],
            },
          } as unknown as App.Locals),
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
        castByOwnerId: null,
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
