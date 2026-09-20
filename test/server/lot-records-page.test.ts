import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import LotRecordsPage from '../../src/pages/lot-records.astro';
import NotFoundPage from '../../src/pages/404.astro';
import { getDb } from '../../src/server/db/client';
import { lotViolations, settings } from '../../src/server/db/schema';
import {
  parties,
  people,
  organizations,
  ownerships,
  representations,
  representationLots,
} from '../../src/server/db/roster-schema';
import { truncateAll, seedProperty, seedLotAuthority } from './fixtures';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../src/lib/types';
import type { AuthContext } from '../../src/server/authz/guards';

/**
 * THE CROSS-LOT SUITE ADR 0024 ASKS FOR, at the surface a reader actually
 * meets (#291 slice 4).
 *
 * `permission-matrix.test.ts` proves the GATE with synthetic capability sets.
 * `lot-records-reads-scoped.test.ts` proves the SCOPE at the query. This one
 * proves what a person is shown: the page is rendered through the real Astro
 * Container API inside the Workers runtime, against seeded roster facts, and
 * asked what reaches the HTML.
 *
 * The caller classes are the ones ADR 0024 names: a sole owner, a co-owner, a
 * Representative (organization-wide and Lot-scoped), a former owner after an
 * end, a buyer with pre-period records on their own Lot, a board caller who
 * holds no Lot, an unlinked account, and `cutover_mode = legacy`.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const DAY_IN_LOT_A = '2026-09-01';

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container;
}

/** A caller as middleware would put one on `locals`. */
function caller(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'u1',
    personId: 'person-1',
    capabilities: new Set(['member']),
    lotIds: ['lot-a'],
    contentTier: 'homeowner',
    hasCurrentBoardTerm: false,
    role: 'homeowner',
    propertyIds: ['lot-a'],
    ...overrides,
  } as AuthContext;
}

const flagsOn: SiteSettings = {
  ...DEFAULT_SITE_SETTINGS,
  officialMode: true,
  lotRecordsEnabled: true,
};

async function render(
  authContext: AuthContext | null,
  site: SiteSettings = flagsOn,
) {
  const container = await makeContainer();
  return container.renderToString(LotRecordsPage, {
    request: new Request('http://localhost/lot-records'),
    locals: { site, authContext } as unknown as App.Locals,
  });
}

/** The response rather than the HTML, so a 404 can be asserted as a STATUS. */
async function renderResponse(
  authContext: AuthContext | null,
  site: SiteSettings,
) {
  const container = await makeContainer();
  return container.renderToResponse(LotRecordsPage, {
    request: new Request('http://localhost/lot-records'),
    locals: { site, authContext } as unknown as App.Locals,
  });
}

async function seedViolation(
  id: string,
  lotId: string,
  overrides: { effectiveDay?: string; status?: string; summary?: string } = {},
) {
  await getDb(env)
    .insert(lotViolations)
    .values({
      id,
      lotId,
      category: 'parking',
      effectiveDay: overrides.effectiveDay ?? DAY_IN_LOT_A,
      summary: overrides.summary ?? `Summary of ${id}`,
      internalNote: `Board note for ${id}`,
      status: (overrides.status ?? 'open') as 'open',
      createdBy: 'board-1',
      createdAt: new Date('2026-09-01T12:00:00Z'),
    });
}

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(representationLots);
  await db.delete(representations);
  await db.delete(organizations);
  await truncateAll();
  await seedProperty('lot-a', { address: '1 Ashebrook Lane' });
  await seedProperty('lot-b', { address: '2 Ashebrook Lane' });
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify(flagsOn),
    updatedAt: new Date(),
  });
});

describe('the gate', () => {
  it('renders the generic 404 when either flag is off', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    for (const site of [
      DEFAULT_SITE_SETTINGS,
      { ...DEFAULT_SITE_SETTINGS, officialMode: true },
      { ...DEFAULT_SITE_SETTINGS, lotRecordsEnabled: true },
    ]) {
      // The STATUS, not just the copy: a hand-rolled 200 carrying 404-ish
      // words would satisfy a string check and still advertise the surface.
      const res = await renderResponse(caller(), site);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('Page not found');
      expect(html).not.toContain('Summary of v-a');
      expect(html).not.toContain('Lot records');
    }
  });
});

describe('what a reader is shown', () => {
  it('shows a sole owner their own lot record', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const html = await render(caller());
    expect(html).toContain('Summary of v-a');
    expect(html).toContain('1 Ashebrook Lane');
  });

  it('never ships the board-only note', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const html = await render(caller());
    expect(html).not.toContain('Board note for v-a');
  });

  it('shows co-owners of one lot the identical records', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedLotAuthority('person-2', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const first = await render(caller());
    const second = await render(caller({ personId: 'person-2' }));
    expect(first).toContain('Summary of v-a');
    expect(second).toContain('Summary of v-a');
  });

  it('shows nothing of another lot, even one the caller claims', async () => {
    // `lotIds`/`propertyIds` are what the caller's context asserts; the read
    // scopes by the roster instead, so a claim on lot-b buys nothing.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-b', 'lot-b');

    const html = await render(
      caller({ lotIds: ['lot-a', 'lot-b'], propertyIds: ['lot-a', 'lot-b'] }),
    );
    expect(html).not.toContain('Summary of v-b');
    expect(html).toContain('There is nothing recorded for your lot');
  });

  it('hides records from before a buyer period', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-06-01' });
    await seedViolation('v-old', 'lot-a', { effectiveDay: '2026-03-01' });
    await seedViolation('v-mine', 'lot-a', { effectiveDay: '2026-07-01' });

    const html = await render(caller());
    expect(html).not.toContain('Summary of v-old');
    expect(html).toContain('Summary of v-mine');
  });

  it('shows a former owner nothing at all', async () => {
    await seedLotAuthority('person-1', 'lot-a', {
      startDay: '2020-01-01',
      endDay: '2026-06-01',
    });
    await seedViolation('v-theirs', 'lot-a', { effectiveDay: '2021-05-05' });

    // A former owner has no `member` capability in production; this asserts
    // the read as well, so the page is safe even if one ever reached it.
    const html = await render(caller());
    expect(html).not.toContain('Summary of v-theirs');
  });

  it('hides a voided record', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-live', 'lot-a');
    await seedViolation('v-void', 'lot-a', { status: 'voided' });

    const html = await render(caller());
    expect(html).toContain('Summary of v-live');
    expect(html).not.toContain('Summary of v-void');
  });

  it("shows an organization's representative the organization's lot", async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const db = getDb(env);
    await db.insert(parties).values({
      id: 'org-1',
      kind: 'organization',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organizations).values({
      partyId: 'org-1',
      partyKind: 'organization',
      legalName: 'Ashebrook Holdings LLC',
      nameNormalized: 'ashebrook holdings llc',
      updatedAt: now,
    });
    await db
      .insert(parties)
      .values({ id: 'rep-1', kind: 'person', createdAt: now, updatedAt: now });
    await db.insert(people).values({
      partyId: 'rep-1',
      fullName: 'Person rep-1',
      nameNormalized: 'person rep-1',
      updatedAt: now,
    });
    await db.insert(ownerships).values({
      id: 'org-1-lot-a',
      ownerPartyId: 'org-1',
      lotId: 'lot-a',
      startDay: '2026-01-01',
      endDay: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(representations).values({
      id: 'rep-1-org-1',
      organizationPartyId: 'org-1',
      representativePersonId: 'rep-1',
      scopeKind: 'organization',
      startDay: '2026-01-01',
      endDay: null,
      createdAt: now,
      updatedAt: now,
    });
    await seedViolation('v-a', 'lot-a', { effectiveDay: '2026-05-01' });
    await seedViolation('v-b', 'lot-b', { effectiveDay: '2026-05-01' });

    const html = await render(caller({ personId: 'rep-1' }));
    expect(html).toContain('Summary of v-a');
    expect(html).not.toContain('Summary of v-b');
  });
});

describe('who is refused, and how', () => {
  it('asks an anonymous reader to sign in, without saying what is here', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const html = await render(null);
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Summary of v-a');
  });

  it('sends an account with no lot authority to verify their property', async () => {
    await seedViolation('v-a', 'lot-a');
    const html = await render(
      caller({ capabilities: new Set([]), lotIds: [], propertyIds: [] }),
    );
    expect(html).toContain('Verify your property');
    expect(html).not.toContain('Summary of v-a');
  });

  it('shows a board member who holds no lot nothing here', async () => {
    // Board access is not Lot Authority. They read every lot through /admin;
    // this surface is for a lot's own holders, and the `member` capability is
    // what it asks for.
    await seedViolation('v-a', 'lot-a');
    const html = await render(
      caller({
        capabilities: new Set(['board']),
        contentTier: 'board',
        role: 'board',
        hasCurrentBoardTerm: true,
        lotIds: [],
        propertyIds: [],
      }),
    );
    expect(html).not.toContain('Summary of v-a');
    expect(html).toContain('Verify your property');
  });

  it('refuses an unlinked account, which is every caller under legacy', async () => {
    // `personId` is null under `cutover_mode = legacy` and for any account
    // with no Person Link: there is no Person to scope by, so nothing is
    // readable — the same refusal /api/member/roster-self gives.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const html = await render(caller({ personId: null }));
    expect(html).not.toContain('Summary of v-a');
    expect(html).toContain('not available through this account');
  });
});
