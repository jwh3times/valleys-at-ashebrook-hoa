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
import * as fx from './fixtures';
import {
  meetings,
  motions,
  boardVotes,
  boardPeople,
  boardAttendance,
  properties,
  owners,
  memberAttendance,
  memberVotes,
} from '../../src/server/db/schema';
import { parties, people, ownerships } from '../../src/server/db/roster-schema';
import MeetingsPage from '../../src/pages/meetings.astro';
import MeetingDetailPage from '../../src/pages/meetings/[id].astro';
import NotFoundPage from '../../src/pages/404.astro';
import { legacyAuthContext } from '../../src/server/authz/context';
import { seedPeopleRows } from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(memberVotes);
  await db.delete(boardVotes);
  await db.delete(memberAttendance);
  await db.delete(boardAttendance);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(boardPeople);
  await db.delete(owners);
  // #248 part 2: ownerships reference both parties and properties with
  // RESTRICT, so the roster goes before the lots it points at.
  await db.delete(ownerships);
  await db.delete(people);
  await db.delete(parties);
  await db.delete(properties);
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
  body?: 'board' | 'member';
}) {
  await getDb(env)
    .insert(meetings)
    .values({
      id: opts.id,
      body: opts.body ?? 'board',
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

async function seedProperty(
  id: string,
  opts: { weight?: number; status?: 'active' | 'inactive' } = {},
) {
  await fx.seedProperty(id, {
    ...(opts.weight === undefined ? {} : { voteWeight: opts.weight }),
    ...(opts.status === undefined ? {} : { status: opts.status }),
  });
}

async function seedPersonFor(id: string, propertyId: string, fullName: string) {
  await fx.seedLotAuthority(id, propertyId, { fullName });
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
    // renderToString discards the response status — Astro.rewrite('/404')
    // itself sets status 200; it's isRoute404(route.route) inside Astro's
    // renderPage, keyed on the target literally being the /404 route, that
    // forces the real 404 status. renderToResponse is what can catch a
    // regression where the body still reads "not found" but the status
    // silently isn't 404 (e.g. a hand-rolled 200 page with 404-ish copy).
    const res = await container.renderToResponse(MeetingDetailPage, {
      params: { id: 'draft1' },
      locals: {
        authContext: legacyAuthContext('b', 'board', []),
      } as unknown as App.Locals,
      request: new Request('http://localhost/meetings/draft1'),
    });
    expect(res.status).toBe(404);
    const html = await res.text();
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
    const res = await container.renderToResponse(MeetingDetailPage, {
      params: { id: 'boardonly1' },
      locals: {
        authContext: legacyAuthContext('h', 'homeowner', ['p1']),
      } as unknown as App.Locals,
      request: new Request('http://localhost/meetings/boardonly1'),
    });
    expect(res.status).toBe(404);
    const html = await res.text();
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
    await seedPeopleRows({
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

  it('renders no attendance or quorum text when no attendance rows exist, even with quorumRequired set', async () => {
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
    // No attendance rows were seeded — the normal state when a board pastes
    // minutes and approves them. Absence of data is not evidence of an empty
    // room, so this must render nothing about attendance or quorum, never a
    // fabricated "0 of 0" line or a quorum verdict.
    expect(html).not.toContain('board members present');
    expect(html).not.toContain('quorum');
  });

  it('derives the present/total count from real seeded attendance rows, pinning both quorum branches', async () => {
    // Every other test in this file leaves board_attendance empty, so
    // `attendance.filter(a => a.present).length` — the page's one piece of
    // unique computation, not exercised anywhere in the fetchMeetingFor
    // helper tests either — was otherwise untested. Two of three present,
    // checked against two different quorum thresholds so both the "met" and
    // "not met" comparison branches are pinned, not just one.
    const db = getDb(env);
    await seedPeopleRows([
      {
        id: 'p1',
        fullName: 'A. Reyes',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'p2',
        fullName: 'B. Ortiz',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'p3',
        fullName: 'C. Kim',
        userId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await seedMeeting({
      id: 'quorum-not-met',
      status: 'approved',
      visibility: 'public',
      title: 'Quorum Not Met Meeting',
      quorumRequired: 3,
    });
    await db.insert(boardAttendance).values([
      { id: 'a1', meetingId: 'quorum-not-met', personId: 'p1', present: true },
      { id: 'a2', meetingId: 'quorum-not-met', personId: 'p2', present: true },
      {
        id: 'a3',
        meetingId: 'quorum-not-met',
        personId: 'p3',
        present: false,
      },
    ]);
    const container = await makeContainer();
    const notMetHtml = await container.renderToString(MeetingDetailPage, {
      params: { id: 'quorum-not-met' },
      request: new Request('http://localhost/meetings/quorum-not-met'),
    });
    expect(notMetHtml).toContain('2 of 3 board members present');
    expect(notMetHtml).toContain('quorum of 3 not met');

    // Same 2-of-3 attendance, a lower threshold — the "met" branch.
    await seedMeeting({
      id: 'quorum-met',
      status: 'approved',
      visibility: 'public',
      title: 'Quorum Met Meeting',
      quorumRequired: 2,
    });
    await db.insert(boardAttendance).values([
      { id: 'a4', meetingId: 'quorum-met', personId: 'p1', present: true },
      { id: 'a5', meetingId: 'quorum-met', personId: 'p2', present: true },
      { id: 'a6', meetingId: 'quorum-met', personId: 'p3', present: false },
    ]);
    const metHtml = await container.renderToString(MeetingDetailPage, {
      params: { id: 'quorum-met' },
      request: new Request('http://localhost/meetings/quorum-met'),
    });
    expect(metHtml).toContain('2 of 3 board members present');
    expect(metHtml).toContain('quorum of 2 met');
    // Make sure that isn't a false-positive substring match against "not met".
    expect(metHtml).not.toContain('not met');
  });

  it('says nothing about attendance or quorum when quorumRequired is null and no attendance rows exist', async () => {
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
    expect(html).not.toContain('board members present');
    expect(html).not.toContain('quorum');
  });

  it('says nothing about attendance or quorum for a member-body meeting, even with attendance rows and quorumRequired set', async () => {
    // MeetingsManager only records attendance/motions for body: 'board'
    // meetings — member meetings show a "future release" note instead — but
    // a member-body meeting is still creatable, approvable, and publishable
    // in this PR. The public page must not hardcode "board members" copy for
    // a body it has no real attendance model for, even if stray attendance
    // rows exist (e.g. left over from the meeting being re-typed as member).
    const db = getDb(env);
    await seedPeopleRows({
      id: 'p1',
      fullName: 'A. Reyes',
      userId: null,
      createdAt: now,
      updatedAt: now,
    });
    await seedMeeting({
      id: 'member1',
      status: 'approved',
      visibility: 'public',
      title: 'Annual Member Meeting',
      quorumRequired: 2,
      body: 'member',
    });
    await db.insert(boardAttendance).values({
      id: 'a1',
      meetingId: 'member1',
      personId: 'p1',
      present: true,
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'member1' },
      request: new Request('http://localhost/meetings/member1'),
    });
    expect(html).toContain('Annual Member Meeting');
    expect(html).not.toContain('board members present');
    expect(html).not.toContain('quorum');
  });

  it('renders the weighted votes-represented line and quorum verdict for a member meeting', async () => {
    const db = getDb(env);
    await seedProperty('p1', { weight: 2, status: 'active' });
    await seedProperty('p2', { weight: 3, status: 'active' });
    await seedMeeting({
      id: 'member-quorum-met',
      status: 'approved',
      visibility: 'public',
      title: 'Annual Meeting Met',
      quorumRequired: 2,
      body: 'member',
    });
    await db.insert(memberAttendance).values([
      {
        id: 'ma1',
        meetingId: 'member-quorum-met',
        propertyId: 'p1',
        present: true,
        representedByPersonId: null,
      },
      {
        id: 'ma2',
        meetingId: 'member-quorum-met',
        propertyId: 'p2',
        present: false,
        representedByPersonId: null,
      },
    ]);
    const container = await makeContainer();
    const metHtml = await container.renderToString(MeetingDetailPage, {
      params: { id: 'member-quorum-met' },
      request: new Request('http://localhost/meetings/member-quorum-met'),
    });
    // Present weight (2, from p1 only) of totalActiveWeight (5, both active
    // properties) — "votes", never "properties", because weights make the
    // two counts differ.
    expect(metHtml).toContain('2 of 5 votes represented');
    expect(metHtml).toContain('quorum of 2 met');
    expect(metHtml).not.toContain('not met');
    expect(metHtml).not.toContain('board members present');

    await seedMeeting({
      id: 'member-quorum-not-met',
      status: 'approved',
      visibility: 'public',
      title: 'Annual Meeting Not Met',
      quorumRequired: 4,
      body: 'member',
    });
    await db.insert(memberAttendance).values([
      {
        id: 'ma3',
        meetingId: 'member-quorum-not-met',
        propertyId: 'p1',
        present: true,
        representedByPersonId: null,
      },
      {
        id: 'ma4',
        meetingId: 'member-quorum-not-met',
        propertyId: 'p2',
        present: false,
        representedByPersonId: null,
      },
    ]);
    const notMetHtml = await container.renderToString(MeetingDetailPage, {
      params: { id: 'member-quorum-not-met' },
      request: new Request('http://localhost/meetings/member-quorum-not-met'),
    });
    expect(notMetHtml).toContain('2 of 5 votes represented');
    expect(notMetHtml).toContain('quorum of 4 not met');
  });

  it('renders no attendance or quorum text for a member meeting with no member attendance rows', async () => {
    await seedProperty('p1', { weight: 2, status: 'active' });
    await seedMeeting({
      id: 'member-no-attendance',
      status: 'approved',
      visibility: 'public',
      title: 'Member Meeting No Attendance',
      quorumRequired: 2,
      body: 'member',
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'member-no-attendance' },
      request: new Request('http://localhost/meetings/member-no-attendance'),
    });
    // No memberAttendance rows were seeded — absence of data is not evidence
    // of an empty room, same rule as the board-meeting case above.
    expect(html).not.toContain('votes represented');
    expect(html).not.toContain('quorum');
  });

  it('renders per-property votes and the weighted tally for a member motion, never the owner names behind them', async () => {
    const db = getDb(env);
    await seedProperty('p1', { weight: 2, status: 'active' });
    await seedProperty('p2', { weight: 1, status: 'active' });
    await seedPersonFor('o1', 'p1', 'A. Reyes');
    await seedPersonFor('o2', 'p2', 'B. Ortiz');
    await seedMeeting({
      id: 'member-motion',
      status: 'approved',
      visibility: 'public',
      title: 'Member Motion Meeting',
      body: 'member',
    });
    await getDb(env).insert(motions).values({
      id: 'mmo1',
      meetingId: 'member-motion',
      sequence: 1,
      text: 'Approve the special assessment',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(memberVotes).values([
      {
        id: 'mv1',
        motionId: 'mmo1',
        propertyId: 'p1',
        castByPersonId: 'o1',
        weight: 2,
        choice: 'yes',
      },
      {
        id: 'mv2',
        motionId: 'mmo1',
        propertyId: 'p2',
        castByPersonId: null,
        weight: 1,
        choice: 'no',
      },
    ]);
    // A representedByName on the same p2 row, from a different owner, so
    // this test also pins that this attendance-side name never leaks —
    // castByName and representedByName are both on the payload
    // fetchMeetingFor returns; only the template not interpolating them
    // keeps them off the page, and that's the invariant this test exists
    // to guard.
    await db.insert(memberAttendance).values([
      {
        id: 'ma1',
        meetingId: 'member-motion',
        propertyId: 'p2',
        present: true,
        representedByPersonId: 'o2',
      },
    ]);
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'member-motion' },
      request: new Request('http://localhost/meetings/member-motion'),
    });
    expect(html).toContain('Approve the special assessment');
    expect(html).not.toContain('Vote not recorded');
    // The weighted tally: 2 yes (from p1's weight-2 vote), 1 no.
    expect(html).toContain('2 yes');
    expect(html).toContain('1 no');
    // Per-property votes, not per-person roll call.
    expect(html).toContain('p1 Ashebrook Lane');
    expect(html).toContain('p2 Ashebrook Lane');
    // No resident names published — the whole privacy story this branch
    // rests on. castByName ('A. Reyes', cast on p1's vote) and
    // representedByName ('B. Ortiz', representing p2's attendance) are
    // both present on the fetchMeetingFor payload; neither may reach the
    // rendered HTML.
    expect(html).not.toContain('A. Reyes');
    expect(html).not.toContain('B. Ortiz');
  });

  it('renders "Vote not recorded" for a member motion with no member votes', async () => {
    await seedProperty('p1', { weight: 1, status: 'active' });
    await seedMeeting({
      id: 'member-motion-novotes',
      status: 'approved',
      visibility: 'public',
      title: 'Member Motion No Votes',
      body: 'member',
    });
    await getDb(env).insert(motions).values({
      id: 'mmo2',
      meetingId: 'member-motion-novotes',
      sequence: 1,
      text: 'Approve the reserve study',
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
    });
    const container = await makeContainer();
    const html = await container.renderToString(MeetingDetailPage, {
      params: { id: 'member-motion-novotes' },
      request: new Request('http://localhost/meetings/member-motion-novotes'),
    });
    expect(html).toContain('Approve the reserve study');
    expect(html).toContain('Vote not recorded');
  });
});
