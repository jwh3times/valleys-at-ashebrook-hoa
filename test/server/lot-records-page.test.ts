import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import LotRecordsPage from '../../src/pages/lot-records.astro';
import NotFoundPage from '../../src/pages/404.astro';
import { getDb } from '../../src/server/db/client';
import {
  duesLedgerEntries,
  lotViolations,
  settings,
} from '../../src/server/db/schema';
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
 * The caller classes are the ones ADR 0024 names: a sole owner, a co-owner, an
 * organization's Representative, a consolidated duplicate Party, a former
 * owner after an end, a buyer with pre-period records on their own Lot, a
 * board caller who holds no Lot, an unlinked account, and `cutover_mode =
 * legacy`. The Lot-scoped Representation is proved at the query instead
 * (`lot-records-reads-scoped.test.ts`), where the scope itself lives.
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
  // No cast: if AuthContext gains a field the page reads, this must fail to
  // compile rather than quietly render a page branching on `undefined`.
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
  };
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

let ledgerSequence = 0;

async function seedEntry(
  lotId: string,
  kind: 'charge' | 'payment' | 'adjustment',
  amountCents: number,
  effectiveDay: string,
  description: string,
) {
  ledgerSequence += 1;
  await getDb(env)
    .insert(duesLedgerEntries)
    .values({
      id: `le${ledgerSequence}`,
      lotId,
      kind,
      amountCents,
      effectiveDay,
      description,
      category: kind === 'charge' ? 'assessment' : null,
      method: kind === 'payment' ? 'check' : null,
      // Board-only, and the point of asserting on it below: the homeowner
      // read never selects this column, so it must not reach the HTML.
      reference: `Board reference ${ledgerSequence}`,
      source: 'board',
      paymentId: null,
      reversesEntryId: null,
      recordedBy: 'board-1',
      recordedAt: new Date('2026-01-01T12:00:00Z'),
      operationKey: `op-${ledgerSequence}`,
    });
}

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(duesLedgerEntries);
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

describe('caching', () => {
  it('marks the page private and uncacheable', async () => {
    // One Lot's enforcement record, rendered into the HTML rather than fetched
    // by an island. A zone cache rule added later must not be able to serve
    // one reader's page to another.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const res = await renderResponse(caller(), flagsOn);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
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
    // Anchored: without this the case would also pass on a page that rendered
    // no records at all.
    expect(html).toContain('Summary of v-a');
    expect(html).not.toContain('Board note for v-a');
  });

  it('shows co-owners of one lot the identical records', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedLotAuthority('person-2', 'lot-a', { startDay: '2026-01-01' });
    await seedViolation('v-a', 'lot-a');

    const first = await render(caller());
    const second = await render(caller({ personId: 'person-2' }));
    // The ADR's claim is that co-owners see the IDENTICAL record — not merely
    // that each sees something. Compared on the rendered list, since the rest
    // of the page differs by nothing here.
    const list = (html: string) => {
      // The whole per-lot region, not one <ul>: the page now renders a section
      // per Lot carrying a balance, a ledger and the compliance records, and
      // comparing only the first list would let the two readers disagree about
      // a balance and still pass.
      const start = html.indexOf('<section class="lot-record">');
      expect(start).toBeGreaterThan(-1);
      const end = html.lastIndexOf('</section>');
      expect(end).toBeGreaterThan(start);
      return html.slice(start, end);
    };
    expect(list(first)).toContain('Summary of v-a');
    expect(list(second)).toEqual(list(first));
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
    // The full sentence, including the period. It is now scoped to the lot the
    // reader actually holds, and the sections come from the roster's
    // addresses, so the second claimed lot buys not even a heading.
    expect(html).toContain('There is nothing recorded for this lot.');
    expect(html).toContain('1 Ashebrook Lane');
    expect(html).not.toContain('2 Ashebrook Lane');
    // The lead must say "lot" and not "lots" for a caller who holds one and
    // claims two.
    expect(html).toContain('What the association records for your lot');
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

    // Handed a caller the PAGE considers a member, so what refuses here is the
    // query rather than the capability — which is the regression worth
    // catching: a page that filtered by `ctx.lotIds` would show this.
    const html = await render(caller());
    expect(html).not.toContain('Summary of v-theirs');
    expect(html).toContain('There is nothing recorded for your lot.');
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

describe('the dues balance a homeowner reads', () => {
  it("shows the lot's balance and every entry behind it, in order", async () => {
    // The whole point of a balance-forward ledger is that the reader can
    // follow it. So this asserts the RUNNING figure at each step, not merely
    // the total: a page that printed the right total against the wrong column
    // of running balances is the version a homeowner brings to a meeting.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 45000, '2026-01-15', 'Winter quarter');
    await seedEntry('lot-a', 'charge', 12500, '2026-02-15', 'Fence repair');
    await seedEntry('lot-a', 'payment', -45000, '2026-03-01', 'Check 1041');

    const html = await render(caller());
    expect(html).toContain('$125.00 owed');
    for (const [description, running] of [
      ['Winter quarter', 'Balance $450.00'],
      ['Fence repair', 'Balance $575.00'],
      ['Check 1041', 'Balance $125.00'],
    ]) {
      expect(html).toContain(description);
      expect(html).toContain(running);
    }
    // The payment's own amount keeps its sign, so a credit on the page cannot
    // be read as another charge.
    expect(html).toContain('-$450.00');
  });

  it('calls a negative balance a credit and never says it is owed', async () => {
    // `describeBalance` exists for this sentence. An overpayment shown as
    // "-$50.00 owed" is the one wording a homeowner would act on wrongly.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 45000, '2026-01-15', 'Winter quarter');
    await seedEntry('lot-a', 'payment', -50000, '2026-02-01', 'Check 1041');

    const html = await render(caller());
    expect(html).toContain('$50.00 in credit');
    expect(html).not.toContain('owed');
  });

  it('collapses what came before the reader period into one undated line', async () => {
    // A buyer does not read the seller's entries, but the balance is the sum
    // of everything the Lot owes — so the earlier entries collapse rather than
    // disappear, and the line carries NO date, because the day it would need
    // (the first day of this reader's authority) is not what either statement
    // returns.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 45000, '2026-03-01', 'Seller quarter');
    await seedEntry('lot-a', 'charge', 12500, '2026-07-01', 'Summer quarter');

    const html = await render(caller());
    expect(html).toContain('Balance brought forward');
    expect(html).not.toContain('Seller quarter');
    expect(html).toContain('Summer quarter');
    // Whole, not partial: $125.00 would be the bug this line exists to
    // prevent.
    expect(html).toContain('$575.00 owed');
    // Both running figures: the brought-forward line, then the itemized entry
    // carrying the balance AFTER it. Asserting only the first would pass on a
    // page that restarted the running total at each row.
    expect(html).toContain('Balance $450.00');
    expect(html).toContain('Balance $575.00');
  });

  it('shows the opening balance alone when every entry predates the reader', async () => {
    // The case the undated line exists FOR: nothing is itemizable, so a page
    // that rendered the opening only alongside detail rows would show this
    // reader a balance with no explanation at all.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-06-01' });
    await seedEntry('lot-a', 'charge', 45000, '2026-03-01', 'Seller quarter');

    const html = await render(caller());
    expect(html).toContain('$450.00 owed');
    expect(html).toContain('Balance brought forward');
    expect(html).not.toContain('Seller quarter');
  });

  it('shows a lot with no ledger at all rather than omitting it', async () => {
    // `fetchMemberDuesLedger` returns nothing for a Lot with no entries, so a
    // page driven by the ledger would render no section — dropping the home
    // of the reader most likely to be checking: the one who owes nothing.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });

    const html = await render(caller());
    expect(html).toContain('1 Ashebrook Lane');
    expect(html).toContain('Nothing owed');
    expect(html).toContain('Nothing has been posted');
  });

  it('never ships the board-only reference', async () => {
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 45000, '2026-01-15', 'Winter quarter');

    const html = await render(caller());
    // Anchored, so the case cannot pass on a page that rendered no ledger.
    expect(html).toContain('Winter quarter');
    expect(html).not.toContain('Board reference');
  });

  it('gives a reader holding two lots two separate balances', async () => {
    // One merged figure would be true of neither home, and the association
    // bills each Lot separately.
    await seedLotAuthority('person-1', 'lot-a', { startDay: '2026-01-01' });
    await seedLotAuthority('person-1', 'lot-b', { startDay: '2026-01-01' });
    await seedEntry('lot-a', 'charge', 45000, '2026-01-15', 'Winter on A');
    await seedEntry('lot-b', 'charge', 12500, '2026-01-15', 'Winter on B');

    const html = await render(caller());
    expect(html).toContain('1 Ashebrook Lane');
    expect(html).toContain('2 Ashebrook Lane');
    expect(html).toContain('$450.00 owed');
    expect(html).toContain('$125.00 owed');
    // Not summed into one: $575.00 is what a merged page would print.
    expect(html).not.toContain('$575.00');
    expect(html).toContain('What the association records for your lots');
  });

  it('shows a former owner no balance, not a zero one', async () => {
    // "Nothing owed" would be a statement about a Lot this reader no longer
    // holds, and they hold no Lot to state it about.
    await seedLotAuthority('person-1', 'lot-a', {
      startDay: '2020-01-01',
      endDay: '2026-06-01',
    });
    await seedEntry('lot-a', 'charge', 45000, '2021-05-05', 'Their quarter');

    const html = await render(caller());
    expect(html).toContain('There is nothing recorded for your lot.');
    expect(html).not.toContain('Nothing owed');
    expect(html).not.toContain('$450.00');
    expect(html).not.toContain('Their quarter');
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
