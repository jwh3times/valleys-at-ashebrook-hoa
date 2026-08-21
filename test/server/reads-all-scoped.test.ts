import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as reads from '../../src/server/content/reads';
import {
  truncateAll,
  seedProperty,
  seedLotAuthority,
  seedMeeting,
  seedElection,
  seedProxy,
} from './fixtures';
import { getDb } from '../../src/server/db/client';
import {
  announcements,
  documents,
  resolutions,
} from '../../src/server/db/schema';

/**
 * Structural guard over the read model, the sibling of
 * `admin-routes-all-gated.test.ts`.
 *
 * That test exists because a new admin route shipped without `requireBoard`
 * breaks nothing that already exists — nobody notices until it is live. The
 * identical argument applies here: ADR 0014's "filter unconditionally, even
 * for a board caller" rule is enforced by fifteen hand-written `where`
 * clauses, and the per-record-type tests are per-record-type, so a sixteenth
 * export ships with no test and nothing fails.
 *
 * `reads.ts` exports fall into exactly three scoping shapes, and the naming
 * convention is the only thing that has ever stated them:
 *
 *   fetch*For(env, role, …)      tier-scoped   — filtered to the caller's tier
 *   fetchAdmin*(env, …)          unscoped      — board-only by construction,
 *                                                reachable only from a
 *                                                requireBoard-gated route
 *   fetchMember*(env, …, ids)    authority-scoped — limited to lots the
 *                                                caller controls
 *
 * Every export must be classified below. A new one that fits none of the
 * three fails `every export is classified`, which is the point: it converts
 * "I forgot to tier-filter this" into a build failure rather than a reviewer
 * obligation.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

/**
 * One record of every type, all at `board` visibility and — where the type
 * has a lifecycle — in the state its public read is supposed to hide. A
 * visitor must therefore see nothing at all.
 */
beforeEach(async () => {
  await truncateAll();
  const db = getDb(env);
  await seedProperty('p1');
  await seedLotAuthority('o1', 'p1');
  await seedMeeting('m1', { visibility: 'board', status: 'draft' });
  await seedElection('e1', { visibility: 'board', status: 'draft' });
  await seedProxy('x1', { meetingId: 'm1' });
  await db.insert(documents).values({
    id: 'd1',
    title: 'Board only',
    filename: 'b.pdf',
    r2Key: 'documents/d1/b.pdf',
    category: 'Policies',
    visibility: 'board',
    sizeBytes: 1,
    contentType: 'application/pdf',
    uploadedAt: now,
    updatedAt: now,
  });
  await db.insert(announcements).values({
    id: 'a1',
    title: 'Board only',
    body: 'x',
    date: '2026-01-01',
    visibility: 'board',
  });
  await db.insert(resolutions).values({
    id: 'r1',
    number: 'R-1',
    title: 'Board only',
    bodyMd: 'x',
    status: 'draft',
    visibility: 'board',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  });
});

/**
 * Tier-scoped exports, each called as a VISITOR. Every one must come back
 * empty against the board-tier fixture above.
 */
const TIER_SCOPED: Record<string, () => Promise<unknown>> = {
  fetchDocumentsFor: () => reads.fetchDocumentsFor(env, 'visitor'),
  fetchAnnouncementsFor: () => reads.fetchAnnouncementsFor(env, 'visitor'),
  fetchMeetingsFor: () => reads.fetchMeetingsFor(env, 'visitor'),
  fetchMeetingFor: () => reads.fetchMeetingFor(env, 'visitor', 'm1'),
  fetchResolutionsFor: () =>
    reads.fetchResolutionsFor(env, 'visitor', { includeHistoric: true }),
  fetchElectionsFor: () => reads.fetchElectionsFor(env, 'visitor'),
  fetchUpcomingOccasionsFor: () =>
    reads.fetchUpcomingOccasionsFor(env, 'visitor', '2020-01-01'),
};

/** Board-only by construction; callable only from a requireBoard-gated route. */
const ADMIN_UNSCOPED = [
  'fetchAdminDocuments',
  'fetchAdminMeetings',
  'fetchAdminMeeting',
  'fetchAdminResolutions',
  'fetchAdminElections',
  'fetchAdminProxies',
];

/** Scoped by the caller's own lots rather than by tier alone. */
const AUTHORITY_SCOPED = ['fetchMemberLots', 'fetchMemberProxies'];

/**
 * Exports that fit none of the three shapes. Adding a name here is allowed
 * but must carry a reason — that is the whole value of the allowlist, which
 * turns "I forgot" into "I had to write down why".
 */
const UNCLASSIFIED: Record<string, string> = {};

describe('every reads.ts export declares a scoping shape', () => {
  const exported = Object.entries(reads)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k);

  it('found the read model to check', () => {
    // Guards against an import that silently resolves to nothing, which would
    // make every assertion below vacuously pass.
    expect(exported.length).toBeGreaterThanOrEqual(15);
  });

  it('every export is classified', () => {
    const classified = new Set([
      ...Object.keys(TIER_SCOPED),
      ...ADMIN_UNSCOPED,
      ...AUTHORITY_SCOPED,
      ...Object.keys(UNCLASSIFIED),
    ]);
    const unknown = exported.filter((name) => !classified.has(name));
    expect(unknown).toEqual([]);
  });

  it('classification matches the naming convention', () => {
    for (const name of Object.keys(TIER_SCOPED))
      expect(name.endsWith('For')).toBe(true);
    for (const name of ADMIN_UNSCOPED)
      expect(name.startsWith('fetchAdmin')).toBe(true);
    for (const name of AUTHORITY_SCOPED)
      expect(name.startsWith('fetchMember')).toBe(true);
  });

  it('no classification names an export that no longer exists', () => {
    // Otherwise deleting a read would leave a stale entry covering nothing.
    const stale = [
      ...Object.keys(TIER_SCOPED),
      ...ADMIN_UNSCOPED,
      ...AUTHORITY_SCOPED,
    ].filter((name) => !exported.includes(name));
    expect(stale).toEqual([]);
  });
});

describe('every tier-scoped read hides board-tier records from a visitor', () => {
  for (const [name, call] of Object.entries(TIER_SCOPED)) {
    it(`${name} returns nothing`, async () => {
      const result = await call();
      if (result === null) return;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });
  }
});

describe('the fixture is real', () => {
  // The positive control. Without this, a beforeEach that silently seeded
  // nothing would make every assertion above pass for the wrong reason.
  it('the same records ARE visible to the board-only reads', async () => {
    expect(await reads.fetchAdminMeetings(env)).toHaveLength(1);
    expect(await reads.fetchAdminElections(env)).toHaveLength(1);
    expect(await reads.fetchAdminResolutions(env)).toHaveLength(1);
    expect(await reads.fetchAdminProxies(env)).toHaveLength(1);
    expect(await reads.fetchAdminDocuments(env)).toHaveLength(1);
  });
});
