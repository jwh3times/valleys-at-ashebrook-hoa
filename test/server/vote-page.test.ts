import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import VotePage from '../../src/pages/vote.astro';
import NotFoundPage from '../../src/pages/404.astro';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import { getDb } from '../../src/server/db/client';
import {
  candidates,
  electionEligibility,
  elections,
  memberVotes,
  motionEligibility,
  motions,
  meetings,
  properties,
  settings,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date('2026-08-07T12:00:00Z');

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberVotes);
  await db.delete(electionEligibility);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(motionEligibility);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(properties);
  await db.delete(settings);
});

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container;
}

function localsWith(
  officialMode: boolean,
  liveVotingEnabled: boolean,
  authContext: unknown,
) {
  return {
    site: { ...DEFAULT_SITE_SETTINGS, officialMode, liveVotingEnabled },
    authContext,
  } as unknown as App.Locals;
}

describe('/vote', () => {
  it('renders the generic 404 when official mode is off', async () => {
    const container = await makeContainer();
    const response = await container.renderToResponse(VotePage, {
      request: new Request('http://localhost/vote'),
      locals: localsWith(false, true, null),
    });
    expect(await response.text()).toContain('Page not found');
  });

  it('renders the generic 404 when live voting is disabled', async () => {
    const container = await makeContainer();
    const response = await container.renderToResponse(VotePage, {
      request: new Request('http://localhost/vote'),
      locals: localsWith(true, false, null),
    });
    expect(await response.text()).toContain('Page not found');
  });

  it('prompts an anonymous visitor to sign in when both flags are on', async () => {
    const container = await makeContainer();
    const html = await container.renderToString(VotePage, {
      request: new Request('http://localhost/vote'),
      locals: localsWith(true, true, null),
    });
    expect(html).toContain('Sign in');
  });

  it('renders an eligible open voting item for a verified homeowner', async () => {
    await insertOpenElection();
    const container = await makeContainer();
    const html = await container.renderToString(VotePage, {
      request: new Request('http://localhost/vote'),
      locals: localsWith(true, true, {
        userId: 'u1',
        role: 'homeowner',
        propertyIds: ['p1'],
      }),
    });
    expect(html).toContain('Board election');
    expect(html).toContain('Candidate One');
    expect(html).toContain('101 Example Street');
  });

  it('renders an empty state for a verified homeowner without open items', async () => {
    const container = await makeContainer();
    const html = await container.renderToString(VotePage, {
      request: new Request('http://localhost/vote'),
      locals: localsWith(true, true, {
        userId: 'u1',
        role: 'homeowner',
        propertyIds: ['p1'],
      }),
    });
    expect(html).toContain(
      'There are no open ballots for your verified properties.',
    );
  });
});

async function insertOpenElection() {
  const db = getDb(env);
  await db.insert(properties).values({
    id: 'p1',
    address: '101 Example Street',
    addressNormalized: '101 example street',
    status: 'active',
    voteWeight: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(elections).values({
    id: 'e1',
    title: 'Board election',
    seats: 1,
    electionDate: '2026-10-01',
    source: 'conducted',
    status: 'open',
    visibility: 'homeowner',
    createdBy: 'b',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(candidates).values({
    id: 'c1',
    electionId: 'e1',
    fullName: 'Candidate One',
    sequence: 1,
    votes: null,
    won: false,
    withdrawn: false,
    createdAt: now,
  });
  await db
    .insert(electionEligibility)
    .values({ electionId: 'e1', propertyId: 'p1', weight: 1 });
}
