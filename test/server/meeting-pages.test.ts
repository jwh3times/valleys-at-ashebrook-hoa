// Page-level (integration) tests for the public meeting record pages,
// rendered through the real Astro Container API inside the actual Workers
// runtime (via @cloudflare/vitest-pool-workers), so `import { env } from
// 'cloudflare:workers'` in the pages resolves exactly as it does in
// production and role-gated D1 reads are exercised for real.
//
// This requires Astro's own Vite plugins (astro compiler, React renderer)
// merged into vitest.workers.config.ts alongside the cloudflareTest plugin —
// see the comment there for why, and for the es-module-lexer alias that
// keeps that merge from tripping an unhandled-rejection under workerd's
// "no runtime WebAssembly.compile" restriction.
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import { getDb } from '../../src/server/db/client';
import {
  meetings,
  motions,
  boardVotes,
  boardPeople,
} from '../../src/server/db/schema';
import MeetingsPage from '../../src/pages/meetings.astro';
import MeetingDetailPage from '../../src/pages/meetings/[id].astro';
import NotFoundPage from '../../src/pages/404.astro';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(boardVotes);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(boardPeople);
});

/**
 * A container wired for these pages: the React renderer (Header renders
 * <SignOutButton client:idle /> whenever `locals.authContext` is set — i.e.
 * whenever the caller is "signed in" — so any locals-bearing render needs
 * it), and the real 404 page registered at /404 so `Astro.rewrite('/404')`
 * has somewhere to go, matching how the Workers runtime resolves it in
 * production.
 */
async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container;
}

async function seedMeeting(opts: {
  id: string;
  status: 'draft' | 'approved';
  visibility: 'public' | 'homeowner' | 'board';
  title?: string;
  quorumRequired?: number | null;
}) {
  await getDb(env)
    .insert(meetings)
    .values({
      id: opts.id,
      body: 'board',
      kind: 'regular',
      date: '2026-09-14',
      title: opts.title ?? `T-${opts.id}`,
      status: opts.status,
      visibility: opts.visibility,
      quorumRequired: opts.quorumRequired ?? null,
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
}

describe('/meetings', () => {
  it('lists an approved meeting and hides a draft', async () => {
    await seedMeeting({
      id: 'approved1',
      status: 'approved',
      visibility: 'public',
      title: 'August Meeting',
    });
    await seedMeeting({
      id: 'draft1',
      status: 'draft',
      visibility: 'public',
      title: 'Not Yet Public',
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingsPage, {
      request: new Request('http://localhost/meetings'),
    });
    expect(html).toContain('Residents Association Meetings');
    expect(html).toContain('August Meeting');
    expect(html).not.toContain('Not Yet Public');
  });
});

describe('/meetings/[id]', () => {
  it("404s a draft meeting's detail URL for a board caller", async () => {
    await seedMeeting({
      id: 'draft1',
      status: 'draft',
      visibility: 'board',
      title: 'Secret Draft Meeting',
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'draft1' },
      locals: {
        authContext: { userId: 'b', role: 'board', propertyIds: [] },
      } as unknown as App.Locals,
      request: new Request('http://localhost/meetings/draft1'),
    });
    expect(html).toContain('Page not found');
    // The 404 must not leak that a meeting exists at this id.
    expect(html).not.toContain('Secret Draft Meeting');
  });

  it("404s a board-visibility meeting's detail URL for a homeowner", async () => {
    await seedMeeting({
      id: 'boardonly1',
      status: 'approved',
      visibility: 'board',
      title: 'Board-Only Session',
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'boardonly1' },
      locals: {
        authContext: { userId: 'h', role: 'homeowner', propertyIds: ['p1'] },
      } as unknown as App.Locals,
      request: new Request('http://localhost/meetings/boardonly1'),
    });
    expect(html).toContain('Page not found');
    expect(html).not.toContain('Board-Only Session');
  });

  it('renders an approved public meeting title and its motion text', async () => {
    await seedMeeting({
      id: 'pub1',
      status: 'approved',
      visibility: 'public',
      title: 'September Meeting',
    });
    await getDb(env).insert(motions).values({
      id: 'mo1',
      meetingId: 'pub1',
      sequence: 1,
      text: 'Approve the annual budget',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'pub1' },
      request: new Request('http://localhost/meetings/pub1'),
    });
    expect(html).toContain('September Meeting');
    expect(html).toContain('Approve the annual budget');
    // No roll call was recorded for this motion — must never render a
    // fabricated 0-0 tally.
    expect(html).toContain('Vote not recorded');
  });

  it('renders a recorded tally instead of "Vote not recorded" once votes exist', async () => {
    await seedMeeting({
      id: 'pub2',
      status: 'approved',
      visibility: 'public',
      title: 'October Meeting',
    });
    await getDb(env).insert(motions).values({
      id: 'mo2',
      meetingId: 'pub2',
      sequence: 1,
      text: 'Approve the vendor contract',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await getDb(env).insert(boardPeople).values({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });
    await getDb(env)
      .insert(boardVotes)
      .values({ id: 'v1', motionId: 'mo2', personId: 'p1', choice: 'yes' });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'pub2' },
      request: new Request('http://localhost/meetings/pub2'),
    });
    expect(html).not.toContain('Vote not recorded');
    expect(html).toContain('1 yes');
  });

  it('shows the quorum-met attendance line when quorumRequired is set', async () => {
    await seedMeeting({
      id: 'pub3',
      status: 'approved',
      visibility: 'public',
      title: 'November Meeting',
      quorumRequired: 2,
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'pub3' },
      request: new Request('http://localhost/meetings/pub3'),
    });
    // No attendance rows were seeded — 0 of 0 present, below the quorum of 2.
    expect(html).toContain('0 of 0 board members present');
    expect(html).toContain('quorum of 2 not met');
  });

  it('says nothing about quorum when quorumRequired is null', async () => {
    await seedMeeting({
      id: 'pub4',
      status: 'approved',
      visibility: 'public',
      title: 'December Meeting',
      quorumRequired: null,
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'pub4' },
      request: new Request('http://localhost/meetings/pub4'),
    });
    expect(html).toContain('0 of 0 board members present');
    expect(html).not.toContain('quorum');
  });
});
