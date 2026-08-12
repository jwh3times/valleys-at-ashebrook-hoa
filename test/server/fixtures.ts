import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  userPropertyLinks,
  propertyVerifications,
  manualApprovalQueue,
  boardPeople,
  boardTerms,
  meetings,
  boardAttendance,
  motions,
  motionEligibility,
  boardVotes,
  memberAttendance,
  memberVotes,
  documents,
  announcements,
  settings,
  reports,
  resolutions,
  elections,
  electionEligibility,
  candidates,
  ballotChoices,
  ballots,
  proxies,
} from '../../src/server/db/schema';

/**
 * Shared fixtures for the Workers/D1 test pool.
 *
 * Before this module every server test re-declared its own `req`, its own
 * `seed*` builders, and its own `beforeEach` delete order. The builders had
 * drifted into three address conventions, and each delete block re-derived the
 * foreign-key ordering by hand — several with comments explaining which FK
 * forced which line. That ordering is a property of the schema, so it belongs
 * in one place.
 *
 * Builders take `(id, …, overrides)` and spread `overrides` last, so a test
 * states only the columns its scenario actually depends on.
 */

/** Fixed clock. Tests that care about time pass `createdAt`/`updatedAt`. */
export const now = new Date();

/** Build the `APIContext`-shaped argument the admin route handlers take. */
export function req(url: string, method: string, body?: unknown) {
  return {
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as never;
}

/**
 * Pause the next D1 batch before it executes so another request can win a
 * deliberately interleaved route-level race.
 *
 * Keep these tests at mutation boundaries where the route itself must wire in
 * a reservation, lifecycle revision, or cross-record invariant. Direct seam
 * tests cover the reservation protocol's mechanics, but cannot catch a route
 * that forgets to use that protocol or returns the wrong conflict response.
 */
export function pauseNextBatch() {
  const originalBatch = env.DATABASE.batch.bind(env.DATABASE);
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batchReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let paused = false;
  const spy = vi
    .spyOn(env.DATABASE, 'batch')
    .mockImplementation(async (statements) => {
      if (!paused) {
        paused = true;
        reached();
        await released;
      }
      return originalBatch(statements);
    });
  return {
    reached: batchReached,
    release,
    restore: () => spy.mockRestore(),
  };
}

/**
 * Empty every application table, children before parents.
 *
 * The order is forced by the schema and is not arbitrary:
 *
 * - `member_attendance`, `member_votes` and `ballots` carry a `proxy_id` FK
 *   with NO ACTION (ADR 0018 — added by ALTER, so drizzle-kit dropped the
 *   action), so they must go before `proxies`.
 * - `proxies` references `owners` and `properties` with RESTRICT.
 * - `candidates` and `board_terms` reference `board_people` with RESTRICT.
 * - `election_eligibility`, `motion_eligibility` and `ballots` reference
 *   `properties` with RESTRICT.
 *
 * `resolutions` self-references with RESTRICT, which is safe here because
 * SQLite checks immediate FKs at the END of a statement, so clearing the whole
 * table at once never observes a half-deleted chain.
 */
export async function truncateAll() {
  const db = getDb(env);
  // Vote/ballot leaves first — these cite proxies, properties and candidates.
  await db.delete(ballotChoices);
  await db.delete(ballots);
  await db.delete(electionEligibility);
  await db.delete(memberVotes);
  await db.delete(memberAttendance);
  await db.delete(motionEligibility);
  await db.delete(boardVotes);
  await db.delete(boardAttendance);
  // Now nothing cites a proxy.
  await db.delete(proxies);
  // Resolutions cite motions; board terms cite elections and board people.
  await db.delete(resolutions);
  await db.delete(boardTerms);
  await db.delete(candidates);
  await db.delete(motions);
  await db.delete(elections);
  await db.delete(meetings);
  await db.delete(boardPeople);
  // Roster: links and verifications cite properties.
  await db.delete(propertyVerifications);
  await db.delete(manualApprovalQueue);
  await db.delete(userPropertyLinks);
  await db.delete(owners);
  await db.delete(properties);
  // Standalone content.
  await db.delete(reports);
  await db.delete(documents);
  await db.delete(announcements);
  await db.delete(settings);
}

export async function seedProperty(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Ashebrook Lane`,
      addressNormalized: `${id} ashebrook lane`,
      unit: null,
      status: 'active',
      voteWeight: 1,
      notes: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

export async function seedOwner(
  id: string,
  propertyId: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(owners)
    .values({
      id,
      propertyId,
      fullName: `Owner ${id}`,
      phone: null,
      email: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

export async function seedBoardPerson(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(boardPeople)
    .values({
      id,
      fullName: `Person ${id}`,
      userId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

/**
 * Defaults to a MEMBER meeting, which is what most callers want. Board-body
 * tests must pass `{ body: 'board' }` — the column decides which voter model
 * applies, so it is never inferred.
 */
export async function seedMeeting(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(meetings)
    .values({
      id,
      body: 'member',
      kind: 'annual',
      date: '2026-09-14',
      title: `Meeting ${id}`,
      status: 'draft',
      visibility: 'board',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

export async function seedMotion(
  id: string,
  meetingId: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env)
    .insert(motions)
    .values({
      id,
      meetingId,
      sequence: 1,
      text: `Motion ${id}`,
      moverPersonId: null,
      secondPersonId: null,
      outcome: 'passed',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

export async function seedElection(
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

export async function seedCandidate(
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

export async function seedBallot(
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
      proxyId: null,
      castByOwnerId: null,
      recordedAt: now,
      ...overrides,
    });
}

/**
 * A proxy row, unsaved. Separate from `seedProxy` because the schema tests
 * insert deliberately-invalid rows to assert the CHECK and unique indexes
 * reject them, and so must build a row without storing it.
 */
export function proxyRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    propertyId: 'p1',
    grantorOwnerId: 'o1',
    holderName: 'Jane Q. Holder',
    holderOwnerId: null,
    meetingId: null,
    electionId: null,
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * One owner authorising one holder for one lot at exactly one occasion. The
 * caller must supply exactly one of `meetingId`/`electionId` — the
 * `proxies_one_occasion` CHECK rejects both or neither.
 */
export async function seedProxy(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  await getDb(env).insert(proxies).values(proxyRow(id, overrides));
}
