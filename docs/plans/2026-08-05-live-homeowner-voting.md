# Live Homeowner Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conduct secret, recountable homeowner elections and attributable member-motion votes at
`/vote`, behind a default-off board-controlled feature flag, with immutable eligibility snapshots
and durable historical results.

**Architecture:** Keep the existing `ballots` rows as the turnout register and store selections in
anonymous `ballot_choices` rows that cannot identify a property or caster. Freeze eligible
properties and weights when voting first opens, enforce lifecycle and casting preconditions inside
atomic D1 batches, and expose open-voting data through a focused server read model. Deliver three
sequential review slices: foundation/lifecycle, API/read security, then homeowner/admin UI.

**Tech Stack:** Astro SSR, TypeScript, React islands, Cloudflare Workers, D1 SQLite, Drizzle ORM,
Vitest, `@cloudflare/vitest-pool-workers`, Testing Library.

## Global Constraints

- `liveVotingEnabled` is stored in the existing `settings.key = 'site'` JSON, defaults to `false`,
  and is board-toggleable; do not add a settings-table column.
- Both `officialMode` and `liveVotingEnabled` must be true for `/vote` and `/api/vote`; either flag
  off returns 404.
- Disabling live voting pauses casting without changing election or motion state and without
  deleting casts.
- Every `POST /api/vote` requires an `Origin` header exactly equal to
  `new URL(request.url).origin`; missing or mismatched origin returns 403.
- Election choices never store or expose a ballot id, property, owner, proxy, caster, or timestamp.
- Election ballots are final; no homeowner or board path edits or retracts one ballot.
- No candidate tally is persisted or exposed while a conducted election is open.
- Eligible properties and weights are frozen at first open and reused across motion close/reopen.
- Conducted election configuration and motion text freeze at first open.
- Use D1 batch atomicity for open, close, cast, and tally derivation; application preflight reads are
  never the concurrency boundary.
- When raw D1 statements write a Drizzle `mode: 'timestamp'` integer column, bind Unix seconds with
  `Math.floor(Date.now() / 1000)`.
- Keep public meeting/election status gates unchanged; `/vote` uses a separate eligible-caller read.
- Use blank-first numeric coercion; never introduce `Number(x) || default`.
- The live-voting flag stays off in defaults, fixtures intended to model production defaults, and
  deployed configuration throughout implementation.

## File and module boundaries

- `src/server/content/voting-state.ts`: database-level flag predicate and lifecycle batch helpers.
- `src/server/content/voting-reads.ts`: eligible-caller open-voting projection only.
- `src/server/content/voting.ts`: cast input normalization and atomic ballot/motion writes only.
- `src/server/authz/voting-guards.ts`: live-voting gate, exact-origin check, and JSON-content check.
- `src/pages/api/vote.ts`: thin HTTP adapter over guards and `voting.ts`.
- `src/lib/voting.ts`: browser casting helpers.
- `src/components/member/VoteManager.tsx`: homeowner casting UI and final confirmation.
- Existing admin routes remain lifecycle owners; existing `reads.ts` remains the historical/public
  record assembler.

---

## Slice 1 — Feature flag, schema, and lifecycle

### Task 1: Add the fail-closed live-voting site setting

**Files:**

- Modify: `src/lib/types.ts:74-126`
- Modify: `test/server/site-settings.test.ts`
- Modify: `test/server/admin-settings-board.test.ts`

**Interfaces:**

- Consumes: existing `SiteSettings`, `DEFAULT_SITE_SETTINGS`, `normalizeSiteSettings`, and
  `PUT /api/admin/site` JSON persistence.
- Produces: `SiteSettings.liveVotingEnabled: boolean`, always present after normalization and false
  unless the stored JSON contains the literal boolean `true`.

- [ ] **Step 1: Write normalization and persistence tests that fail without the flag**

```ts
expect(DEFAULT_SITE_SETTINGS.liveVotingEnabled).toBe(false);
expect(normalizeSiteSettings({ officialMode: true }).liveVotingEnabled).toBe(
  false,
);
expect(
  normalizeSiteSettings({ officialMode: true, liveVotingEnabled: true })
    .liveVotingEnabled,
).toBe(true);
expect(
  normalizeSiteSettings({ liveVotingEnabled: 'true' }).liveVotingEnabled,
).toBe(false);
```

In `admin-settings-board.test.ts`, PUT a complete settings body containing
`liveVotingEnabled: true`, read `settings.value`, normalize it, and assert the flag is true.

- [ ] **Step 2: Run the focused tests and verify the missing property fails**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/site-settings.test.ts test/server/admin-settings-board.test.ts
```

Expected: FAIL because `liveVotingEnabled` is absent from the type/default/normalizer.

- [ ] **Step 3: Add the strict boolean setting contract**

```ts
export interface SiteSettings {
  // existing fields stay unchanged
  officialMode: boolean;
  liveVotingEnabled: boolean;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  // existing defaults stay unchanged
  officialMode: false,
  liveVotingEnabled: false,
};

// inside normalizeSiteSettings's returned object
liveVotingEnabled: r.liveVotingEnabled === true,
```

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/site-settings.test.ts test/server/admin-settings-board.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/types.ts test/server/site-settings.test.ts test/server/admin-settings-board.test.ts
git commit -m "feat: add live voting feature flag"
```

### Task 2: Add the digital ballot box and immutable electorate snapshots

**Files:**

- Modify: `src/server/db/schema.ts:251-304,529-645`
- Create: next Drizzle migration and snapshot under `src/server/db/migrations/`
- Modify: `src/server/db/migrations/meta/_journal.json` through Drizzle generation
- Create: `test/server/voting-schema.test.ts`
- Modify: `test/server/election-schema.test.ts`
- Modify: `test/server/meeting-schema.test.ts`

**Interfaces:**

- Consumes: `properties`, `motions`, `elections`, `candidates`, and existing D1 migration tooling.
- Produces: `MotionVotingState`, `motions.votingState`, `ballotChoices`, `electionEligibility`, and
  `motionEligibility` Drizzle tables.

- [ ] **Step 1: Write schema tests for exact columns, keys, defaults, and delete actions**

Use `PRAGMA table_info`, `PRAGMA foreign_key_list`, and direct constraint writes. Pin these shapes:

```ts
expect(ballotChoiceColumns).toEqual([
  'id',
  'election_id',
  'candidate_id',
  'weight',
]);
expect(ballotChoiceColumns).not.toContain('ballot_id');
expect(ballotChoiceColumns).not.toContain('property_id');
expect(ballotChoiceColumns).not.toContain('created_at');
expect(motionVotingState.defaultValue).toBe("'none'");
expect(electionEligibilityColumns).toEqual([
  'election_id',
  'property_id',
  'weight',
]);
expect(motionEligibilityColumns).toEqual([
  'motion_id',
  'property_id',
  'weight',
]);
```

Also prove duplicate parent/property pairs fail, negative weights fail, parent deletion cascades,
and property deletion is restricted.

- [ ] **Step 2: Run the schema test and verify missing tables/column failures**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/voting-schema.test.ts test/server/election-schema.test.ts test/server/meeting-schema.test.ts
```

Expected: FAIL because the three tables and `motions.voting_state` do not exist.

- [ ] **Step 3: Declare the schema with explicit database constraints**

Add the motion field:

```ts
votingState: text('voting_state', {
  enum: ['none', 'open', 'closed'],
})
  .notNull()
  .default('none'),
```

Declare both snapshot tables with composite unique indexes and non-negative checks:

```ts
export const electionEligibility = sqliteTable(
  'election_eligibility',
  {
    electionId: text('election_id')
      .notNull()
      .references(() => elections.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    weight: integer('weight').notNull(),
  },
  (t) => [
    uniqueIndex('election_eligibility_parent_property_unq').on(
      t.electionId,
      t.propertyId,
    ),
    check('election_eligibility_weight_nonnegative', sql`${t.weight} >= 0`),
  ],
);
```

Use the same shape for `motionEligibility`, substituting `motionId`, `motions.id`, and
`motion_eligibility_*` names.

Declare the choice table without any correlation columns:

```ts
export const ballotChoices = sqliteTable(
  'ballot_choices',
  {
    id: text('id').primaryKey(),
    electionId: text('election_id')
      .notNull()
      .references(() => elections.id, { onDelete: 'cascade' }),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => candidates.id, { onDelete: 'restrict' }),
    weight: integer('weight').notNull(),
  },
  (t) => [
    index('ballot_choices_election_id_idx').on(t.electionId),
    check('ballot_choices_weight_nonnegative', sql`${t.weight} >= 0`),
  ],
);
```

- [ ] **Step 4: Generate and inspect migration 0016**

Run:

```bash
npm run db:generate
```

Expected migration content: three `CREATE TABLE` statements, their indexes, and
`ALTER TABLE motions ADD voting_state text DEFAULT 'none' NOT NULL`. Confirm it does not rebuild
or alter `ballots`, `candidates`, `properties`, or `settings`.

- [ ] **Step 5: Run formatting and schema tests**

Run:

```bash
npm run format
npx vitest run --config vitest.workers.config.ts test/server/voting-schema.test.ts test/server/election-schema.test.ts test/server/meeting-schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the schema and generated migration**

```bash
git add src/server/db/schema.ts src/server/db/migrations test/server/voting-schema.test.ts test/server/election-schema.test.ts test/server/meeting-schema.test.ts
git commit -m "feat: add live voting schema"
```

### Task 3: Make historical reads use frozen eligibility denominators

**Files:**

- Modify: `src/lib/types.ts:700-741,1021-1078`
- Modify: `src/server/content/reads.ts:193-389,671-875`
- Modify: `test/server/election-reads.test.ts`
- Modify: `test/server/meeting-reads.test.ts`

**Interfaces:**

- Consumes: Task 2's eligibility tables and current active-property fallback.
- Produces: `MotionVotingState`, motion-level eligibility totals, board-only election eligibility
  rows, and stable historical turnout denominators.

- [ ] **Step 1: Write read tests that mutate the roster after snapshot creation**

For a conducted election, insert two snapshot rows totaling weight 3, then change both current
property weights and deactivate one property. Assert:

```ts
expect(detail.turnout).toMatchObject({
  eligibleCount: 2,
  eligibleWeight: 3,
});
expect(detail.eligibleProperties).toEqual([
  expect.objectContaining({ propertyId: propertyA, weight: 1 }),
  expect.objectContaining({ propertyId: propertyB, weight: 2 }),
]);
```

For a member motion, insert a snapshot totaling weight 3, mutate the roster, and assert the motion
still reports `eligibleCount: 2`, `eligibleWeight: 3`, and `eligibilityFrozen: true`. Retain a
recorded election and never-opened motion fixture proving they use current active totals.

- [ ] **Step 2: Run focused read tests and verify denominator drift**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/election-reads.test.ts test/server/meeting-reads.test.ts
```

Expected: FAIL because reads currently use current active properties unconditionally.

- [ ] **Step 3: Extend the shared response types**

```ts
export type MotionVotingState = 'none' | 'open' | 'closed';

export interface EligibilityTotals {
  eligibleCount: number;
  eligibleWeight: number;
  eligibilityFrozen: boolean;
}

export interface ElectionEligibleProperty {
  propertyId: string;
  address: string;
  weight: number;
}
```

Add `votingState` plus the three `EligibilityTotals` fields to `MotionDetail`. Add
`eligibilityFrozen` to `ElectionTurnout` and add
`eligibleProperties: ElectionEligibleProperty[] | null` to `ElectionDetail`. Public election reads
always return `eligibleProperties: null`.

- [ ] **Step 4: Implement snapshot-first, current-roster-fallback assembly**

Add focused internal helpers in `reads.ts`:

```ts
async function electionEligibilityFor(
  db: Db,
  electionId: string,
): Promise<{
  totals: EligibilityTotals;
  rows: ElectionEligibleProperty[];
}>;

async function motionEligibilityById(
  db: Db,
  motionIds: string[],
): Promise<Map<string, EligibilityTotals>>;
```

If snapshot rows exist, count and sum their stored weights. If no rows exist, use the current active
property count/weight and mark `eligibilityFrozen: false`. In `assembleMeetingDetail`, attach the
per-motion result and `mo.votingState`. In `assembleElectionDetail`, attach snapshot totals and
include the address-resolved rows only when `includeBallots` is true.

- [ ] **Step 5: Run read tests and commit**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/election-reads.test.ts test/server/meeting-reads.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/types.ts src/server/content/reads.ts test/server/election-reads.test.ts test/server/meeting-reads.test.ts
git commit -m "feat: preserve voting eligibility history"
```

### Task 4: Implement conducted-election lifecycle and freeze rules

**Files:**

- Create: `src/server/content/voting-state.ts`
- Create: `test/server/voting-state.test.ts`
- Modify: `src/lib/types.ts:1021-1166`
- Modify: `src/pages/api/admin/elections.ts`
- Modify: `src/pages/api/admin/candidates.ts`
- Modify: `test/unit/election-normalize.test.ts`
- Modify: `test/server/admin-elections-board.test.ts`
- Modify: `test/server/admin-candidates-board.test.ts`

**Interfaces:**

- Consumes: Tasks 1-3 settings, tables, and read types.
- Produces: `LIVE_VOTING_ENABLED_SQL`, `liveVotingEnabledInDb`, `source: 'conducted'` creation,
  election `open`, atomic snapshot/open and tally/close actions, and post-open configuration
  immutability.

- [ ] **Step 1: Write type and route tests for the conducted lifecycle**

Pin these behaviors:

```ts
expect(
  normalizeElectionInput(
    {
      title: '2027 Election',
      seats: 2,
      electionDate: '2027-03-01',
      source: 'conducted',
    },
    'create',
  ),
).toMatchObject({ ok: true, value: { source: 'conducted' } });

expect(normalizeElectionInput({ source: 'recorded' }, 'patch')).toMatchObject({
  ok: false,
});
```

Worker tests must prove open is 409 when the flag is off, source is recorded, status is not draft,
visibility is board, candidates are absent, or active properties are absent. A successful open must
create one eligibility row per active property and set status to `open` in one request. Closing must
set status `closed`, store weighted sums including real zero, and retain all anonymous choices.

- [ ] **Step 2: Run focused tests and verify lifecycle failures**

Run:

```bash
npx vitest run test/unit/election-normalize.test.ts
npx vitest run --config vitest.workers.config.ts test/server/voting-state.test.ts test/server/admin-elections-board.test.ts test/server/admin-candidates-board.test.ts
```

Expected: FAIL because `open`, create-time source selection, and lifecycle batches are absent.

- [ ] **Step 3: Add the database flag predicate and status type**

In `voting-state.ts`, export one constant usable by raw D1 statements and one Drizzle wrapper over
that same constant. Missing or invalid JSON evaluates false:

```ts
export const LIVE_VOTING_ENABLED_SQL = `
  EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'site'
      AND CASE WHEN json_valid(value)
        THEN json_extract(value, '$.officialMode') = 1
         AND json_extract(value, '$.liveVotingEnabled') = 1
        ELSE 0
      END
  )
` as const;

export const liveVotingEnabledInDb = sql.raw(LIVE_VOTING_ENABLED_SQL);
```

Unit-test the predicate through a temporary settings row for missing, malformed, false, and true
values.

Add `'open'` to `ElectionStatus` and `ELECTION_STATUSES`. Add `source?: ElectionSource` to
`ElectionInput`; accept it only in create mode using `enumField`, defaulting to recorded in the
route.

- [ ] **Step 4: Add atomic `open` and conducted `close` actions**

Use `env.DATABASE.batch()` with prepared SQL so the update result's `meta.changes` can distinguish
the winning transition. The open batch must:

1. update only a draft conducted election with a non-board visibility, at least one active
   candidate, at least one active property, and `liveVotingEnabledInDb`;
2. insert all active property ids and weights into `election_eligibility`; and
3. return 204 only when the status update changed one row.

The conducted close batch must:

```sql
UPDATE elections
SET status = 'closed', updated_at = ?
WHERE id = ? AND source = 'conducted' AND status = 'open'
RETURNING id;

UPDATE candidates
SET votes = COALESCE(
  (SELECT SUM(bc.weight)
   FROM ballot_choices bc
   WHERE bc.candidate_id = candidates.id),
  0
)
WHERE election_id = ?
  AND EXISTS (
    SELECT 1 FROM elections
    WHERE elections.id = candidates.election_id
      AND elections.status = 'closed'
  );
```

Keep recorded close as `draft → closed`. Add `case 'open'` to POST dispatch. Keep `void` legal from
draft, open, or closed and illegal from certified/void.

- [ ] **Step 5: Freeze election and candidate configuration after open**

- `PATCH /api/admin/elections`: conducted elections accept changes only in draft; recorded behavior
  remains unchanged.
- `POST /api/admin/candidates`: accept only draft elections.
- `PATCH /api/admin/candidates`: draft accepts existing fields; open conducted elections accept
  only `{ withdrawn: true }` when currently not withdrawn; every other change returns 409.
- `DELETE /api/admin/candidates`: retain the existing draft-only rule.

Use this exact open-withdrawal test assertion:

```ts
expect(await patchCandidate(candidateId, { withdrawn: true })).toBe(204);
expect(await patchCandidate(candidateId, { withdrawn: false })).toBe(409);
expect(await patchCandidate(candidateId, { fullName: 'Changed' })).toBe(409);
```

- [ ] **Step 6: Run lifecycle tests and commit**

Run:

```bash
npx vitest run test/unit/election-normalize.test.ts
npx vitest run --config vitest.workers.config.ts test/server/voting-state.test.ts test/server/admin-elections-board.test.ts test/server/admin-candidates-board.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/server/content/voting-state.ts src/lib/types.ts src/pages/api/admin/elections.ts src/pages/api/admin/candidates.ts test/server/voting-state.test.ts test/unit/election-normalize.test.ts test/server/admin-elections-board.test.ts test/server/admin-candidates-board.test.ts
git commit -m "feat: add conducted election lifecycle"
```

### Task 5: Implement member-motion lifecycle and record retention

**Files:**

- Modify: `src/pages/api/admin/motions.ts`
- Modify: `src/pages/api/admin/meetings.ts`
- Modify: `test/server/admin-motions-member.test.ts`
- Modify: `test/server/admin-meetings-member.test.ts`

**Interfaces:**

- Consumes: `liveVotingEnabledInDb`, `motionEligibility`, `motions.votingState`, and existing
  `setMemberVotes`.
- Produces: `openVoting`/`closeVoting`, immutable first-open snapshots, stable snapshot-weight board
  corrections, text freeze, and deletion guards.

- [ ] **Step 1: Write failing motion lifecycle and retention tests**

Cover these exact transitions and guards:

```ts
expect(await openVoting(boardMeetingMotion)).toBe(409);
expect(await openVoting(approvedMeetingMotion)).toBe(409);
expect(await openVoting(memberMotionWithFlagOff)).toBe(409);
expect(await openVoting(memberMotionWithPreenteredVotes)).toBe(409);
expect(await openVoting(validMemberMotion)).toBe(204);
expect(await openVoting(validMemberMotion)).toBe(409);
expect(await closeVoting(validMemberMotion)).toBe(204);
expect(await openVoting(validMemberMotion)).toBe(204);
```

Assert the eligibility rows are identical before and after close/reopen even after adding a new
property and changing a snapshotted weight. Assert `setMemberVotes` is 409 while open and uses
snapshot weights after close. Assert motion text edits, motion deletion, and parent-meeting deletion
are 409 after first open.

- [ ] **Step 2: Run focused tests and verify missing lifecycle actions**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/admin-motions-member.test.ts test/server/admin-meetings-member.test.ts
```

Expected: FAIL because motion voting state is not enforced.

- [ ] **Step 3: Add atomic open/close actions**

Add POST cases `openVoting` and `closeVoting`. The open batch updates only a motion whose parent is
a draft member meeting and whose current state is `none` or `closed`. It requires the global flag.
For first open (`state = 'none'`), it also requires no existing `member_votes` and at least one
active property, then inserts all active property ids and weights. For reopen (`state = 'closed'`),
it requires an existing snapshot and inserts no new eligibility rows.

The close statement is:

```sql
UPDATE motions
SET voting_state = 'closed', updated_at = ?
WHERE id = ?
  AND voting_state = 'open'
  AND EXISTS (
    SELECT 1 FROM meetings
    WHERE meetings.id = motions.meeting_id
      AND meetings.body = 'member'
      AND meetings.status = 'draft'
  )
RETURNING id;
```

- [ ] **Step 4: Enforce editing and deletion invariants**

- `setMemberVotes`: return 409 while open; when a snapshot exists, resolve weights from
  `motion_eligibility` and reject properties outside it; otherwise preserve current-property
  behavior.
- Motion PATCH: reject every field while open; after close, reject `text` but permit outcome,
  mover, and second.
- Motion DELETE: return 409 when `votingState !== 'none'`.
- Meeting DELETE: before cascade, return 409 if any owned motion has `votingState !== 'none'` or a
  `motion_eligibility` row.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/admin-motions-member.test.ts test/server/admin-meetings-member.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/pages/api/admin/motions.ts src/pages/api/admin/meetings.ts test/server/admin-motions-member.test.ts test/server/admin-meetings-member.test.ts
git commit -m "feat: add live motion voting lifecycle"
```

### Task 6: Document and verify Slice 1

**Files:**

- Create: `docs/adr/0020-digital-ballot-box.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/architecture.md`
- Modify: `SECURITY.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: completed Slice 1 implementation and approved design.
- Produces: durable architecture/security record and a merge-ready foundation slice.

- [ ] **Step 1: Run the repository docs-updater skill**

Invoke `docs-updater` and update the listed docs. ADR 0020 must record: anonymous retained choices,
eligibility record date, final ballots, no live tally, close-time derivation, residual D1 insertion
order/Time Travel correlation risk, and the prohibition on adding a ballot-choice link.

- [ ] **Step 2: Add the Slice 1 changelog entry for the version the merge will mint**

Use `scripts/next-version.sh` to obtain the exact release version. Describe the default-off flag,
schema, snapshot, and lifecycle work; do not claim `/vote` is available yet.

- [ ] **Step 3: Run Slice 1 verification**

```bash
npm run format:check
npm run agents:check
npm run lint:coercions
npm run check
npm test
npm run test:server
npm run build
```

Expected: every command exits 0.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/adr/0020-digital-ballot-box.md docs/adr/README.md docs/architecture.md SECURITY.md AGENTS.md CHANGELOG.md
git commit -m "docs: record live voting foundation"
```

- [ ] **Step 5: Review and merge Slice 1 before starting Slice 2**

Run the `code-reviewer` skill with emphasis on default-off behavior, transition-only fields,
snapshot immutability, D1 batch outcomes, and deletion guards. Address every correctness/security
finding, rerun the full gate, then use `ship` to push and open the Slice 1 PR. Start Slice 2 from the
merged Slice 1 main commit.

---

## Slice 2 — Voting API and eligible-caller read model

### Task 7: Add strict voting guards and structural route coverage

**Files:**

- Create: `src/server/authz/voting-guards.ts`
- Create: `src/pages/api/vote.ts`
- Create: `test/server/voting-guards.test.ts`
- Modify: `src/middleware.ts:46-118`
- Modify: `test/server/middleware.test.ts`
- Modify: `test/server/member-routes-all-gated.test.ts`

**Interfaces:**

- Consumes: normalized site settings and `resolveAuthContext`.
- Produces:
  `requireVotingApi(locals, request, env): Promise<{ok:true;ctx:AuthContext}|{ok:false;res:Response}>`
  and `sameOriginError(request): Response | null`.

- [ ] **Step 1: Write guard-order and route-enumeration tests**

Pin the order with requests that would fail later checks:

```ts
expect(
  (await call({ official: false, live: true, origin: 'foreign' })).status,
).toBe(404);
expect(
  (await call({ official: true, live: false, origin: 'foreign' })).status,
).toBe(404);
expect((await call({ official: true, live: true, origin: null })).status).toBe(
  403,
);
expect(
  (await call({ official: true, live: true, origin: 'https://evil.test' }))
    .status,
).toBe(403);
expect(
  (await call({ official: true, live: true, origin: 'http://localhost' }))
    .status,
).toBe(401);
```

Change the member route glob to `../../src/pages/api/member/**/*.ts` and explicitly include
`../../src/pages/api/vote.ts`. The structural cases must prove official off → 404, voting off → 404
for the vote route only, anonymous → 401, and visitor → 403. Requests intended to reach auth must
carry `origin: 'http://localhost'` and `content-type: application/json` so the earlier checks pass.

- [ ] **Step 2: Run guard and middleware tests and verify failure**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/voting-guards.test.ts test/server/member-routes-all-gated.test.ts test/server/middleware.test.ts
```

Expected: FAIL because `/api/vote` and its guard do not exist.

- [ ] **Step 3: Implement exact origin and JSON checks**

```ts
export function sameOriginError(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin)
    return new Response('Forbidden', { status: 403 });
  return null;
}

export function jsonContentError(request: Request): Response | null {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim();
  return mediaType === 'application/json'
    ? null
    : new Response('Unsupported media type', { status: 415 });
}
```

`requireVotingApi` must read settings first, return 404 for either flag off, then apply origin and
content checks, then resolve auth and require homeowner rank. Board rank passes.

Create a guard-only route so structural enumeration covers the real path before casting lands:

```ts
export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireVotingApi(locals, request, env);
  if (!gate.ok) return gate.res;
  return new Response('Unknown action', { status: 400 });
};
```

- [ ] **Step 4: Extend middleware without gating proxy routes on live voting**

Use separate predicates:

```ts
function isMemberApi(path: string): boolean {
  return path === '/api/member' || path.startsWith('/api/member/');
}

function isVotingApi(path: string): boolean {
  return path === '/api/vote' || path.startsWith('/api/vote/');
}
```

Both load real settings and require official mode. Only `isVotingApi` additionally requires
`liveVotingEnabled`. Preserve 401/403 behavior after the flags.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/voting-guards.test.ts test/server/member-routes-all-gated.test.ts test/server/middleware.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/server/authz/voting-guards.ts src/pages/api/vote.ts src/middleware.ts test/server/voting-guards.test.ts test/server/member-routes-all-gated.test.ts test/server/middleware.test.ts
git commit -m "feat: gate live voting routes"
```

### Task 8: Build the eligible-caller open-voting read model

**Files:**

- Create: `src/server/content/voting-reads.ts`
- Modify: `src/lib/types.ts`
- Create: `test/server/voting-reads.test.ts`

**Interfaces:**

- Consumes: `AuthContext`, eligibility snapshots, candidates, member motions, proxies, owners,
  properties, ballots, member votes, and `visibleTiers`.
- Produces: `fetchOpenVotingFor(env, ctx): Promise<OpenVotingItem[]>`.

- [ ] **Step 1: Define and test the response contract**

Add these shared types:

```ts
export interface VotingOwnerOption {
  id: string;
  fullName: string;
}

export interface VotingProxyOption {
  id: string;
  holderName: string;
  grantingAddress: string;
}

export interface VotingLot {
  propertyId: string;
  address: string;
  weight: number;
  hasCast: boolean;
  ownerOptions: VotingOwnerOption[];
  proxyOptions: VotingProxyOption[];
}

export interface OpenElectionVotingItem {
  kind: 'election';
  id: string;
  title: string;
  date: string;
  seats: number;
  candidates: { id: string; fullName: string; statementMd: string | null }[];
  lots: VotingLot[];
}

export interface OpenMotionVotingItem {
  kind: 'motion';
  id: string;
  text: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  lots: VotingLot[];
}

export type OpenVotingItem = OpenElectionVotingItem | OpenMotionVotingItem;
```

Tests must cover own lots, held proxies, meeting-scoped proxies covering an election, tier
visibility, snapshot-only eligibility, duplicate representation deduplication, withdrawn candidate
omission, per-lot received state, and empty results for no verified lots.

- [ ] **Step 2: Run the read test and verify the missing module failure**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/voting-reads.test.ts
```

Expected: FAIL because `voting-reads.ts` and the response types do not exist.

- [ ] **Step 3: Implement the focused read projection**

`fetchOpenVotingFor` must:

1. select open conducted elections and open motions on draft member meetings within
   `visibleTiers(ctx.role)`;
2. select active owners of `ctx.propertyIds` and proxies held by those owners;
3. intersect target properties with each item's eligibility snapshot;
4. build one `VotingLot` per target property, combining own-owner and proxy options without
   duplicating the lot;
5. stamp weight from the snapshot, never the current property row;
6. mark `hasCast` from `ballots` or `member_votes`; and
7. select candidate identity/statement only, never `votes`, `won`, choices, or turnout totals.

Keep SQL scoped to the discovered open item ids; guard every `inArray` call against an empty list.

- [ ] **Step 4: Add explicit non-disclosure assertions**

```ts
const json = JSON.stringify(items);
expect(json).not.toContain('candidateId":"selected');
expect(json).not.toContain('votes');
expect(json).not.toContain('ballotChoices');
expect(json).not.toContain('recordedAt');
```

Also call existing `fetchElectionsFor` and `fetchMeetingFor` fixtures to prove open/draft records
remain absent from the public read paths.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npx vitest run --config vitest.workers.config.ts test/server/voting-reads.test.ts test/server/election-reads.test.ts test/server/meeting-reads.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/server/content/voting-reads.ts src/lib/types.ts test/server/voting-reads.test.ts test/server/election-reads.test.ts test/server/meeting-reads.test.ts
git commit -m "feat: add open voting read model"
```

### Task 9: Implement atomic election and motion casting

**Files:**

- Create: `src/server/content/voting.ts`
- Modify: `src/pages/api/vote.ts`
- Modify: `src/lib/types.ts`
- Create: `test/unit/voting-input.test.ts`
- Create: `test/server/vote-api.test.ts`
- Create: `test/server/vote-concurrency.test.ts`

**Interfaces:**

- Consumes: `requireVotingApi`, eligibility snapshots, user-property links, owners, proxies,
  candidates, `liveVotingEnabledInDb`, and existing unique indexes.
- Produces:
  `normalizeVoteAction(raw): VoteActionResult`,
  `castElectionBallot(env, ctx, input): Promise<VoteWriteResult>`, and
  `castMotionVote(env, ctx, input): Promise<VoteWriteResult>`.

- [ ] **Step 1: Write strict input normalization tests**

Define discriminated inputs:

```ts
export interface CastBallotInput {
  action: 'castBallot';
  electionId: string;
  propertyId: string;
  candidateIds: string[];
  castByOwnerId: string | null;
  proxyId: string | null;
}

export interface CastMotionVoteInput {
  action: 'castMotionVote';
  motionId: string;
  propertyId: string;
  choice: 'yes' | 'no' | 'abstain';
  castByOwnerId: string | null;
  proxyId: string | null;
}

export type VoteWriteResult =
  { ok: true } | { ok: false; status: 400 | 403 | 404 | 409; message: string };
```

Place both input interfaces in `src/lib/types.ts` so the server and browser client share one
contract without importing a server-only module into the client bundle.

Tests reject unknown actions, empty ids, empty/duplicate candidate arrays, invalid choices, both
provenance fields, and neither provenance field.

- [ ] **Step 2: Write Worker tests for every security and eligibility response**

Include flag and origin ordering, malformed JSON, non-JSON media type, unknown/out-of-tier item,
non-open lifecycle, recorded election, property outside snapshot, owner outside target property,
inactive owner, invalid proxy scope, proxy not held by caller, withdrawn/foreign candidates,
candidate count above seats, and second cast. Assert the documented 400/401/403/404/409/415 codes.

- [ ] **Step 3: Write atomicity and race tests before the implementation**

For a two-choice ballot, assert an invalid second candidate leaves both counts zero:

```ts
expect(await ballotCount(electionId)).toBe(0);
expect(await choiceCount(electionId)).toBe(0);
```

Run two valid casts concurrently for the same property:

```ts
const responses = await Promise.all([cast(), cast()]);
expect(responses.map((r) => r.status).sort()).toEqual([204, 409]);
expect(await ballotCount(electionId)).toBe(1);
expect(await choiceCount(electionId)).toBe(2);
```

For cast-versus-close and cast-versus-pause, allow either serialized winner but assert only these
complete states:

```ts
expect([
  { cast: 204, ballots: 1, choices: 2 },
  { cast: 409, ballots: 0, choices: 0 },
]).toContainEqual(observed);
```

If close wins after the cast, assert its final candidate sums include the ballot. If close wins
first, assert all candidate totals are zero.

- [ ] **Step 4: Run tests and verify missing API/service failures**

Run:

```bash
npx vitest run test/unit/voting-input.test.ts
npx vitest run --config vitest.workers.config.ts test/server/vote-api.test.ts test/server/vote-concurrency.test.ts
```

Expected: FAIL because casting modules do not exist.

- [ ] **Step 5: Implement preflight errors and database-conditioned ballot casting**

First perform read-only preflight checks in the documented order so ordinary failures retain their
specific response: unknown/out-of-tier item → 404, invalid candidate/owner shape → 400, caller not
entitled through the selected proxy → 403, and known non-open lifecycle → 409. Treat these reads as
error selection only; repeat every mutable success condition inside the write statement.

Use `env.DATABASE.batch()` and generated UUIDs. The first prepared statement inserts the turnout row
with an `INSERT`-from-`SELECT` only when all mutable conditions still hold in the same database
batch:

- both settings JSON flags are true;
- election source/status are `conducted/open`;
- an `election_eligibility` row exists and supplies the stored weight;
- the complete distinct candidate id set belongs to the election, is not withdrawn, and does not
  exceed immutable `seats`;
- own casting still has a caller link plus active owner on the target lot, or proxy casting still
  has a matching occasion plus an active holder owner on a currently linked caller lot; and
- no ballot exists for the election/property pair.

Each choice statement has this form and does not store the turnout id:

```sql
INSERT INTO ballot_choices (id, election_id, candidate_id, weight)
SELECT ?, ?, ?, ee.weight
FROM election_eligibility ee
WHERE ee.election_id = ?
  AND ee.property_id = ?
  AND EXISTS (SELECT 1 FROM ballots WHERE id = ?);
```

If the turnout statement changes zero rows, every choice statement changes zero rows. If a unique
constraint loses a race, D1 rolls back the batch. Map both outcomes to 409. Return 204 only when the
turnout result changed one row and every choice result changed one row.

- [ ] **Step 6: Implement database-conditioned motion casting**

Insert one `member_votes` row using the snapshot weight and the same own/proxy validity checks. The
statement must also require `motions.voting_state = 'open'`, a draft member parent meeting, both
settings flags, and absence of the motion/property unique pair. Map zero changes or unique failure
to 409; return 204 only for one inserted row.

- [ ] **Step 7: Add the thin POST route**

```ts
export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireVotingApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const action = normalizeVoteAction(parsed.value);
  if (!action.ok) return new Response(action.error, { status: 400 });
  const result =
    action.value.action === 'castBallot'
      ? await castElectionBallot(env, gate.ctx, action.value)
      : await castMotionVote(env, gate.ctx, action.value);
  return result.ok
    ? new Response(null, { status: 204 })
    : new Response(result.message, { status: result.status });
};
```

- [ ] **Step 8: Run API, concurrency, lifecycle, and schema tests**

Run:

```bash
npx vitest run test/unit/voting-input.test.ts
npx vitest run --config vitest.workers.config.ts test/server/voting-guards.test.ts test/server/vote-api.test.ts test/server/vote-concurrency.test.ts test/server/admin-elections-board.test.ts test/server/admin-motions-member.test.ts test/server/voting-schema.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the casting boundary**

```bash
git add src/lib/types.ts src/server/content/voting.ts src/pages/api/vote.ts test/unit/voting-input.test.ts test/server/vote-api.test.ts test/server/vote-concurrency.test.ts
git commit -m "feat: add atomic homeowner voting api"
```

### Task 10: Security-review and verify Slice 2

**Files:**

- Modify: `SECURITY.md`
- Modify: `docs/architecture.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: completed guards, reads, and casting API.
- Produces: a security-reviewed, merge-ready API slice with the UI still unreachable because no
  `/vote` page or navigation exists and the flag defaults off.

- [ ] **Step 1: Run the `code-reviewer` skill on the complete Slice 2 diff**

The review must explicitly inspect gate ordering, exact-origin handling, JSON enforcement,
visibility masking, own/proxy SQL predicates, snapshot-only weights, anonymous schema boundaries,
batch-result checks, unique-race mapping, and absence of live tally reads.

- [ ] **Step 2: Resolve findings with focused regression tests**

For each accepted finding, first add a test that reproduces it, run that test to see it fail, apply
the smallest correction, and rerun the focused suite. Do not weaken 404 masking or expose a new
choice correlation field to simplify a fix.

- [ ] **Step 3: Refresh security and architecture documentation**

Invoke `docs-updater`. Document the exact Origin rule, route gate order, snapshot record date,
anonymous retained choices, final ballots, and the fact that no UI has shipped in this slice.
Update the changelog for this slice's predicted merge version.

- [ ] **Step 4: Run the full repository gate**

```bash
npm run format:check
npm run agents:check
npm run lint:coercions
npm run check
npm test
npm run test:server
npm run build
```

Expected: every command exits 0.

- [ ] **Step 5: Commit docs, ship, and merge Slice 2**

```bash
git add SECURITY.md docs/architecture.md AGENTS.md CHANGELOG.md
git commit -m "docs: document live voting security boundary"
```

Use `ship` to push and open the Slice 2 PR. Merge only after CI and security review are green. Start
Slice 3 from the merged Slice 2 main commit.

---

## Slice 3 — Homeowner and admin experience

### Task 11: Add the homeowner `/vote` experience

**Files:**

- Create: `src/lib/voting.ts`
- Create: `src/components/member/VoteManager.tsx`
- Create: `src/components/member/VoteManager.test.tsx`
- Create: `src/pages/vote.astro`
- Create: `test/server/vote-page.test.ts`
- Modify: `src/lib/site.ts`
- Modify: `src/components/Header.astro`
- Modify: `test/unit/site.test.ts`

**Interfaces:**

- Consumes: `fetchOpenVotingFor`, `OpenVotingItem[]`, and POST `/api/vote`.
- Consumes: the existing safe `ReportMarkdown` renderer for candidate statements; do not introduce
  `dangerouslySetInnerHTML`.
- Produces: `castBallot`, `castMotionVote`, SSR `/vote`, accessible final-ballot confirmation,
  receipts, and feature-gated navigation.

- [ ] **Step 1: Write client-helper tests**

```ts
await castBallot({
  electionId: 'e1',
  propertyId: 'p1',
  candidateIds: ['c1', 'c2'],
  castByOwnerId: 'o1',
  proxyId: null,
});

expect(fetch).toHaveBeenCalledWith('/api/vote', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'castBallot',
    electionId: 'e1',
    propertyId: 'p1',
    candidateIds: ['c1', 'c2'],
    castByOwnerId: 'o1',
    proxyId: null,
  }),
});
```

Add the corresponding `castMotionVote` assertion and readable response-text error behavior.

- [ ] **Step 2: Write page and navigation gate tests**

Page tests must prove official off → generic 404, live flag off → generic 404, both on plus anonymous
→ sign-in prompt, verified caller → vote content, and verified caller with no items → empty state.
Use a positive-control fixture that renders an open eligible item.

Change `accountNav` to consume:

```ts
type VotingMode = Pick<SiteSettings, 'officialMode' | 'liveVotingEnabled'>;
```

Assert a verified homeowner receives Proxies whenever official mode is on and Vote only when both
flags are on. A board caller with verified property ids receives Admin plus Vote; a board caller
without verified property ids receives Admin only.

- [ ] **Step 3: Write component tests for finality, provenance, and receipts**

Cover one-seat and multi-seat elections, seat-limit enforcement, own-owner selection, proxy
selection, motion choices, server errors, disabled controls after success, and this finality flow:

```ts
fireEvent.click(screen.getByLabelText('Candidate One'));
fireEvent.click(screen.getByRole('button', { name: /review ballot/i }));
expect(screen.getByText(/cannot be changed or recovered/i)).toBeVisible();
expect(castBallot).not.toHaveBeenCalled();
fireEvent.click(screen.getByRole('button', { name: /cast final ballot/i }));
await screen.findByText(/ballot received for 101 example street/i);
expect(screen.queryByText(/candidate one/i)).not.toBeInTheDocument();
```

The last assertion applies to the receipt region after the form is replaced; the review dialog may
show selections before submission.

- [ ] **Step 4: Run tests and verify missing UI failures**

Run:

```bash
npx vitest run src/components/member/VoteManager.test.tsx test/unit/site.test.ts
npx vitest run --config vitest.workers.config.ts test/server/vote-page.test.ts
```

Expected: FAIL because the client, component, page, and links do not exist.

- [ ] **Step 5: Implement the browser helpers and VoteManager**

Export exact helper signatures:

```ts
export async function castBallot(
  input: Omit<CastBallotInput, 'action'>,
): Promise<void>;
export async function castMotionVote(
  input: Omit<CastMotionVoteInput, 'action'>,
): Promise<void>;
```

`VoteManager` takes `{ items: OpenVotingItem[] }`. Keep per-item/per-lot form state isolated. Replace
a successful form with a receipt that contains only item title and property address. Refetching is
not required; update `hasCast` locally only after a 204 response.

- [ ] **Step 6: Implement the SSR page and gated account links**

`vote.astro` must perform both flag checks before reading voting data:

```ts
if (!site.officialMode || !site.liveVotingEnabled) {
  return Astro.rewrite('/404');
}

const ctx = Astro.locals.authContext ?? null;
const verified =
  ctx !== null && ctx.role !== 'visitor' && ctx.propertyIds.length > 0;
const items = verified ? await fetchOpenVotingFor(env, ctx) : [];
```

Render sign-in, verification, empty, and `VoteManager client:load` states. Pass the complete site
mode object to `accountNav` from `Header.astro`.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npx vitest run src/components/member/VoteManager.test.tsx test/unit/site.test.ts
npx vitest run --config vitest.workers.config.ts test/server/vote-page.test.ts test/server/voting-reads.test.ts test/server/vote-api.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/voting.ts src/components/member/VoteManager.tsx src/components/member/VoteManager.test.tsx src/pages/vote.astro test/server/vote-page.test.ts src/lib/site.ts src/components/Header.astro test/unit/site.test.ts
git commit -m "feat: add homeowner live voting page"
```

### Task 12: Add admin controls and explicit election history

**Files:**

- Modify: `src/lib/admin.ts:618-740`
- Modify: `src/components/admin/SiteManager.tsx`
- Modify: `src/components/admin/SiteManager.test.tsx`
- Modify: `src/components/admin/ElectionsManager.tsx`
- Modify: `src/components/admin/ElectionsManager.test.tsx`
- Modify: `src/components/admin/MeetingsManager.tsx`
- Modify: `src/components/admin/MeetingsManager.test.tsx`
- Create: `test/unit/admin-voting-client.test.ts`

**Interfaces:**

- Consumes: admin election/motion lifecycle actions, expanded `ElectionDetail` and `MotionDetail`,
  and public `fetchSiteSettings`.
- Produces: `openElection`, `openMotionVoting`, `closeMotionVoting`, Active/History election views,
  turnout-only open monitoring, and paused-state labels.

- [ ] **Step 1: Write admin client-helper tests**

Pin request bodies:

```ts
await openElection('e1');
expect(fetch).toHaveBeenLastCalledWith(
  '/api/admin/elections',
  expect.objectContaining({
    body: JSON.stringify({ action: 'open', id: 'e1' }),
  }),
);

await openMotionVoting('m1');
expect(fetch).toHaveBeenLastCalledWith(
  '/api/admin/motions',
  expect.objectContaining({
    body: JSON.stringify({ action: 'openVoting', id: 'm1' }),
  }),
);

await closeMotionVoting('m1');
expect(fetch).toHaveBeenLastCalledWith(
  '/api/admin/motions',
  expect.objectContaining({
    body: JSON.stringify({ action: 'closeVoting', id: 'm1' }),
  }),
);
```

Add `source` to the create input passed by `saveElection`. When `id` is present, destructure source
out before serializing the PATCH body so the create-immutable field never reaches PATCH.

Extend the SiteManager fixture with `liveVotingEnabled: false`. Add a test that enables Live Voting,
saves, and asserts `saveSite` received `{ liveVotingEnabled: true }`.

- [ ] **Step 2: Write ElectionsManager behavior tests**

Cover:

- create form offers Recorded and Conducted;
- draft conducted election has Open, not Close;
- open conducted election shows turnout count/weight and no candidate tally or tally editor;
- open plus global flag off shows “Paused globally” and retains Close;
- Active view contains draft/open only;
- History contains closed/certified/void;
- closed conducted totals and eligible denominators are read-only;
- eligibility rows and turnout provenance show addresses/weights but no selection field; and
- recorded election editors retain current behavior.

- [ ] **Step 3: Write MeetingsManager behavior tests**

Cover Open voting for `none`, Close voting for `open`, Reopen voting for `closed`, globally paused
label, no bulk member-vote editor while open, and historical weighted tally plus frozen eligible
weight after close.

- [ ] **Step 4: Run component tests and verify missing controls**

Run:

```bash
npx vitest run test/unit/admin-voting-client.test.ts src/components/admin/SiteManager.test.tsx src/components/admin/ElectionsManager.test.tsx src/components/admin/MeetingsManager.test.tsx
```

Expected: FAIL because the lifecycle controls and history split are absent.

- [ ] **Step 5: Implement admin helpers and election views**

Add:

```ts
export async function openElection(id: string): Promise<void>;
export async function openMotionVoting(id: string): Promise<void>;
export async function closeMotionVoting(id: string): Promise<void>;
```

Add the board toggle to `SiteManager`:

```tsx
<input
  type="checkbox"
  checked={site.liveVotingEnabled}
  onChange={(event) =>
    setSite({ ...site, liveVotingEnabled: event.target.checked })
  }
/>
<span>Live voting</span>
<p>
  Enables homeowner election ballots and member-motion votes. Turning this off
  pauses every open vote without closing it or deleting received votes.
</p>
```

In `ElectionsManager`, add `source` to the create-only form. Replace `STATUS_GROUPS` rendering with
an Active/History view selector while retaining status headings inside each view. Fetch site
settings once to determine the paused label. Hide ballot/tally editors for conducted elections;
show only turnout while open and read-only derived totals in history.

- [ ] **Step 6: Implement motion controls without weakening board-edit guards**

Fetch the site flag once. Render Open/Close/Reopen actions from `votingState`, show paused globally
when state is open and the flag is off, and hide the bulk member vote editor only while open. Keep
server responses authoritative and surface their readable text.

- [ ] **Step 7: Run component and server lifecycle tests**

Run:

```bash
npx vitest run test/unit/admin-voting-client.test.ts src/components/admin/SiteManager.test.tsx src/components/admin/ElectionsManager.test.tsx src/components/admin/MeetingsManager.test.tsx
npx vitest run --config vitest.workers.config.ts test/server/admin-elections-board.test.ts test/server/admin-motions-member.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the admin experience**

```bash
git add src/lib/admin.ts src/components/admin/SiteManager.tsx src/components/admin/SiteManager.test.tsx src/components/admin/ElectionsManager.tsx src/components/admin/ElectionsManager.test.tsx src/components/admin/MeetingsManager.tsx src/components/admin/MeetingsManager.test.tsx test/unit/admin-voting-client.test.ts
git commit -m "feat: add live voting admin controls and history"
```

### Task 13: Final documentation, security review, and release verification

**Files:**

- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `SECURITY.md`
- Modify: `docs/architecture.md`
- Modify: `AGENTS.md`
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: complete Phase 1 behavior.
- Produces: operator/maintainer documentation, an implementation-complete roadmap entry, and a
  merge-ready final slice.

- [ ] **Step 1: Run `docs-updater` and document the complete workflow**

Document how the board enables/pauses voting, prepares and opens conducted elections, opens member
motions, views turnout, closes and reviews history, and leaves the feature disabled until formal
adoption. Describe the exact Origin requirement and final-ballot warning in SECURITY. Update
ROADMAP item 9 to implemented only after all behavior and tests pass.

- [ ] **Step 2: Update the changelog for the predicted merge version**

Use `scripts/next-version.sh`. Include homeowner `/vote`, admin Active/History, strict origin,
atomic casting, anonymous choices, snapshot denominators, pause behavior, and final ballots.

- [ ] **Step 3: Run the `code-reviewer` skill on the entire Slice 3 diff and the combined Phase 1 range**

Review access control, feature gates, page 404 behavior, client/server field parity, absence of
selection leakage in receipts/history, no live tallies, finality messaging, proxy scope, and admin
edit controls. Add a regression test before each accepted correction.

- [ ] **Step 4: Run the complete local CI gate**

```bash
npm run format:check
npm run agents:check
npm run lint:coercions
npm run check
npm test
npm run test:server
npm run build
```

Expected: every command exits 0 with `liveVotingEnabled` still false in defaults.

- [ ] **Step 5: Inspect the final diff for secrecy regressions**

Run:

```bash
rg -n "ballotId|propertyId|ownerId|proxyId|recordedAt|createdAt|updatedAt" src/server/db/schema.ts src/server/content/voting.ts src/server/content/voting-reads.ts
git diff --check
git status --short
```

Expected: `ballot_choices` has none of the forbidden correlation columns; turnout and proxy code
may legitimately contain these names outside that table. `git diff --check` prints nothing, and
status lists only intended Phase 1 files.

- [ ] **Step 6: Commit final documentation**

```bash
git add README.md SETUP.md SECURITY.md docs/architecture.md AGENTS.md ROADMAP.md CHANGELOG.md
git commit -m "docs: complete live homeowner voting rollout"
```

- [ ] **Step 7: Ship Slice 3 without enabling production voting**

Use `ship` to push and open the final PR. Require green CI and resolved security review. After merge,
confirm the production setting remains `liveVotingEnabled: false`; enabling it is a separate board
operation after formal adoption and an operator smoke test.
