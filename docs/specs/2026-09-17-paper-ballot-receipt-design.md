# Paper Ballot Receipt and Turnout Amendment — Design

- **Date:** 2026-09-17
- **Status:** Draft
- **Issue:** #302

## Purpose

A verified homeowner can confirm that a ballot was received for a **conducted** election: `/vote`
shows a per-lot `hasCast` receipt that never includes a selection. A **recorded paper** election
offers no such check. Per-lot turnout for paper elections is board-only on purpose. The public
and homeowner tiers see only aggregate turnout, because listing which lots returned a ballot next
to the tallies would let someone work out individual votes in a small race.

The board decided this at its 2026-08-11 meeting, and the decision is recorded in the minutes:

> Build it. A verified homeowner gets a caller-specific, selection-free check that their lot is
> recorded as having returned a paper ballot, preserving every constraint in the issue's "What a
> fix has to preserve". Correction process: a homeowner who disputes a missing record contacts
> the board; the board verifies against the physical ballot and, if it was missed, amends the
> turnout record before certification. After certification, the result must be uncertified
> before any amendment.

This spec covers two things: how the receipt is read, and how the board amends the record. The
constraints the issue fixes are binding:

- The receipt is **caller-specific and selection-free**. It says whether the lot is recorded as
  having returned a ballot. It never says what the ballot said, and it never says anything about
  another lot.
- It must not become an **oracle for per-lot turnout**. A caller may only ask about lots they
  hold, and the scoping happens **inside the query**, never as a filter after the read.
- **Absence reads as "not recorded"**, a real state the homeowner can dispute.

## Goals

- Show each verified homeowner, beside each recorded paper election they can see, whether each
  lot they held on the election's date is recorded as having returned a ballot.
- Word the no-record state so it tells the homeowner what to do: contact the board.
- Give the board a concrete amendment path in the existing write surface, before and after
  certification, without collateral damage to the rest of the turnout register.
- Leave ballot secrecy and the per-lot turnout register's board-only status exactly as they are
  today for everyone except the lot's own holders.

## Non-goals

- A receipt for conducted elections after close. `/vote` covers conducted elections while they
  are open, and conducted ballots cannot be amended.
- Any display of selections, tallies per lot, weight, proxy or caster provenance, or recording
  time.
- A homeowner-initiated dispute form or any homeowner write. Disputes go to the board through
  existing channels.
- Receipts for proxy-held lots, or for callers who hold no lot today.
- A new audit-ledger event family (see [Audit](#audit)).

## Code facts this design rests on

Each fact below was checked against the code. Several of them contradict what the issue assumes.

1. **`/vote` cannot host this receipt.** `src/pages/vote.astro` rewrites to `/404` unless both
   `officialMode` and `liveVotingEnabled` are true. `fetchOpenVotingFor`
   (`src/server/content/voting-reads.ts`) reads only `source = 'conducted' AND status = 'open'`,
   so `hasCast` disappears at close.
2. **The conducted receipt does not use derived access.** `fetchOpenVotingFor` and the cast path
   in `src/server/content/voting.ts` scope a caller's lots through `resolveCastingAuthority`
   (`src/server/content/casting-authority.ts`). That reads `user_property_links`, a legacy
   write-behind mirror that `test/unit/legacy-roster-consumers.test.ts` lists as
   `needs-repointing`. It does not read the ADR 0022 derivation. "Reuse the conducted receipt's
   scoping" would therefore add a new consumer of a table that phase 4 (#212) drops. The derived
   lot set is `LOT_SQL` in `src/server/authz/derive.ts`, which becomes `AuthContext.lotIds`.
3. **Recorded elections have no frozen electorate.** `election_eligibility` is written only by
   the conducted `open` action (`openElection` in `src/pages/api/admin/elections.ts`). For every
   other election, `electionEligibilityById` (`src/server/content/reads.ts`) falls back to the
   _current_ active properties, with `eligibilityFrozen: false`. "The lots the caller holds" must
   therefore be pinned to a date explicitly, because no snapshot answers it.
4. **`/elections` is not flag-gated.** `src/pages/elections.astro` renders in resident mode and
   official mode alike. `fetchElectionsFor` returns only `closed`/`certified` elections at the
   caller's tier, with `ballots: null`. `/elections` appears in `BASE_NAV`
   (`src/lib/site.ts`) under both modes. There is no per-election detail page.
5. **`setBallots` already allows amendment while the election is `draft` or `closed`.** It
   returns `409` for `certified`/`void` and for non-`recorded` elections, and it takes the
   `__replacing_ballots__` reservation (`src/server/content/election-reservation.ts`), so a
   competing certify or void that wins first leaves the register intact.
6. **`setBallots` is a delete-and-reinsert, and that damages an amendment.** Every call runs
   `DELETE FROM ballots WHERE election_id = ?` and re-inserts every row with a fresh `id` and
   `recorded_at = now`. That has three effects:
   - `review_flags.impacted_ballot_id` is `ON DELETE SET NULL` (`src/server/db/audit-schema.ts`).
     Adding one missed lot therefore silently strips the ballot reference from every open flag on
     that election.
   - Retrospective discovery in `src/server/roster/transfer-effects.ts` selects ballots by
     `b.recorded_at` inside the transfer window. After an amendment, every ballot in the
     election looks freshly recorded, and a later backdated transfer would flag all of them as
     `intervening_action_backdated`.
   - Nothing records who made the change. `setBallots` writes no audit event, and `ballots` has
     no actor column.
7. **Uncertifying has costs beyond status.** `uncertifyElection` voids the
   `board_service_terms` and office assignments that certification created. It ends every Board
   Access grant those terms qualified, with `recorded_in_error`, clears `won`, returns the
   election to `closed`, and writes `board_service_change`/`access` audit events. A later
   certification creates new terms but no grants, and per `CONTEXT.md` Board Access "never
   resumes automatically". `electionAffordances` (`src/lib/affordances.ts`) mirrors this:
   `canEditBallots = recorded && !terminal` and `canUncertify = status === 'certified'`.
8. **The audit ledger has no election family.** `EVENT_FAMILIES` in `audit-schema.ts` is
   `roster_change`, `board_service_change`, `identity`, `access`, `roster_redaction`, `review`,
   and `audit_record_correction`, and the family is enforced by a CHECK constraint. Adding one
   means rebuilding `audit_events`.

## Decisions

### 1. Placement: on `/elections`, rendered server-side, with no API

The receipt appears **inside each recorded election's card on `/elections`**, as a "Your lot's
ballot" block. It renders only for a caller who holds the `member` capability. There is **no new
API route and no new page.**

- `/vote` is ruled out by fact 1. A new page would repeat the election list's tier and status
  filtering just to show one line per election.
- The homeowner is already reading the record the receipt refers to, and the aggregate turnout
  on that card is what gives "not recorded" its meaning (see
  [Presentation](#4-presentation-and-copy)).
- An SSR-only read follows the conducted precedent that "there is no GET voting API"
  (`docs/agents/voting-and-ballots.md`). With no route there are no request parameters: no
  election id and no lot id. Nothing is available to enumerate, and no response exists that
  could confirm a hidden election, which answers the 404-not-403 rule by construction. Hidden
  elections never reach the page because `fetchElectionsFor` excludes them. The receipt SQL also
  re-checks status and tier itself (decision 3), so even a wrong id list yields zero rows.
- When the render includes any caller-specific content, the page sets
  `Cache-Control: private, no-store`. No page sets a cache header today, but `/elections` is also
  a public page, and caller-specific HTML must never become cacheable if a zone cache rule is
  added later.

### 2. Flags: neither `officialMode` nor `liveVotingEnabled` gates it

- **`liveVotingEnabled` does not apply.** It is the gate for opening and casting in _conducted_
  voting (`LIVE_VOTING_ENABLED_SQL`, `src/server/content/voting-state.ts`). A paper election is
  never conducted on the site.
- **`officialMode` does not apply.** ADR 0019 gates homeowner **writes**, meaning association
  business conducted _through_ the site. Recording what happened elsewhere is what PRs 1–6 do,
  ungated. The receipt is a tier-scoped **read** of that record. The record it reads, `/elections`
  and its turnout register, already exists in resident mode (fact 4). Gating the receipt on the
  mode would leave the record visible and the check hidden, for no secrecy benefit.
- The copy follows the brand mode, like the rest of the page. It says "the board" and links to
  `/contact`, and it never uses HOA wording when `officialMode` is off.

### 3. The read: `fetchPaperBallotReceipts`

A new server-only module, `src/server/content/ballot-receipts.ts`, is a sibling of
`voting-reads.ts`. It is not an export of `reads.ts`, because its signature fits none of the
three shapes that `test/server/reads-all-scoped.test.ts` classifies.

```ts
export interface PaperBallotReceiptLot {
  address: string;
  recorded: boolean;
}

/** Keyed by election id. An election absent from the map yields no receipt block. */
export type PaperBallotReceipts = Map<string, PaperBallotReceiptLot[]>;

export async function fetchPaperBallotReceipts(
  env: Env,
  ctx: AuthContext,
  elections: Pick<ElectionDetail, 'id' | 'electionDate' | 'source'>[],
): Promise<PaperBallotReceipts>;
```

**Guard.** The page calls it only when `ctx !== null && ctx.capabilities.has('member')`. The
module returns an empty map if `member` is absent, repeating the page's check. An anonymous
caller, an unlinked account, and a board member who owns no lot all get no receipt block, which
matches the member surfaces' capability semantics (`requireMemberApi`,
`src/server/authz/member-guards.ts`).

**Scoping inside the SQL.** The module runs one statement per visible `recorded` election, all in
one `env.DATABASE.batch`. Elections happen about once a year, so the batch is small. The lot set
is `LOT_SQL` itself, embedded as a subquery. The account id is bound as `?1` and **the election's
own date** as `?2`:

```sql
SELECT p.address AS address,
       EXISTS (
         SELECT 1 FROM ballots b
         WHERE b.election_id = e.id AND b.property_id = p.id
       ) AS recorded
FROM elections e
JOIN properties p ON p.id IN (/* LOT_SQL: ?1 = account id, ?2 = Association Day */)
WHERE e.id = ?3
  AND e.election_date = ?2
  AND e.source = 'recorded'
  AND e.status IN ('closed', 'certified')
  AND /* tier predicate: fixed literal chosen from ctx.contentTier, as voting.ts's
         visibilityPredicate does — never a caller-supplied value */
ORDER BY p.address, p.id
```

- Reusing `LOT_SQL` verbatim means there is still **one definition of "the caller's Lots"**. The
  receipt sees exactly what `deriveAccess` would compute on that day, including organization-wide
  and lot-scoped Representation, one-hop consolidation canonicalization, and retired-lot
  exclusion. No `user_property_links` read is added (fact 2).
- Scoping, status, source, tier, and the date binding are all in one statement, so a
  caller-controlled list could not widen it. The only rows that can come back are lots the
  caller's current Person Link held on that election's date. `recorded` is an `EXISTS` for that
  single `(election, lot)` pair: the query never selects `ballots` columns and never lists other
  lots.
- `e.election_date = ?2` guards against a race. If the board edits the election's date between
  `fetchElectionsFor` and this batch, the statement returns zero rows instead of answering for the
  wrong day. The next render corrects it.
- Under `cutover_mode = legacy` (rollback only), no Person Link rows drive access, so `LOT_SQL`
  returns nothing and the receipt renders nothing. That fails closed, which is correct for a
  model that phase 4 deletes.
- The returned objects carry `address` and `recorded` only: no lot id, weight, `proxy_id`,
  `cast_by_person_id`, or `recorded_at`. The module never logs results.

**Which lots: those held on the election date, not those held today.** A recorded election has
no frozen electorate (fact 3). The rule is therefore Lot Authority **on the election's
Association Day**. That is the question the board's own paper-record path already asks:
`setBallots` evaluates proxy grantor authority on `election.electionDate`, and transfer-effects
applies the occasion-day rule. Concretely:

- An owner who sold after the election, and who still holds some lot today (and so still has
  `member`), sees the receipt for the sold lot. The ballot was their act.
- A buyer whose Ownership starts after the election day sees nothing for that election. The
  previous holder's participation is not the buyer's to learn.
- A Representative sees a lot owned by the Organization only if the Representation and the
  Organization's Ownership both covered the election day, which mirrors `LOT_SQL`'s branches.
- A backdated Ownership whose Effective Day is on or before the election day counts. That is
  exactly what an Effective Day means (`CONTEXT.md`).
- A lot held today but not on the election day is not shown, so held-now-but-not-then shows
  nothing. A lot held then and still held now is shown once.
- **Proxy-held lots are excluded.** A proxy holder has no Lot Authority over the granting lot,
  and the grantor, who does, can check it themselves.

**States shown.** Only `closed` and `certified` recorded elections, which is exactly
`RECORDED_ELECTION_STATUSES` in `reads.ts`:

- `draft` is not a record yet (ADR 0014's never-confirm posture, applied to elections by
  `fetchElectionsFor`). Showing receipts while the board is still keying ballots would also
  create false disputes, and would let a homeowner watch the register being entered.
- `closed` is the **dispute window**, when an amendment needs no uncertification.
- `certified` stays visible, because a missed ballot may surface late. Its copy states that a
  correction requires the board to uncertify first.
- `void` is never shown.
- Conducted elections are excluded (`source = 'recorded'`). Their ballots are final, and the
  correction process does not apply to them.

### 4. Presentation and copy

Each lot row in the block reads one of three ways:

| Condition                                              | Copy (sense, not final wording)                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `recorded = true`                                      | "Your ballot for {address} is recorded as returned." The ballot's content is never recorded.        |
| `recorded = false`, election `turnout.ballotsCast > 0` | "No ballot is recorded for {address}. If you returned one, contact the board." Links to `/contact`. |
| `recorded = false`, election `turnout.ballotsCast = 0` | "The board has not entered this election's ballot register yet."                                    |

- On a `certified` election, the no-record line adds: "This result is certified; correcting it
  requires the board to uncertify it first."
- The `ballotsCast = 0` distinction uses the aggregate turnout already published on the same
  card, so it adds no disclosure. It stops a closed election whose register has not been keyed
  from telling every homeowner "not recorded".
- If the caller has `member` but held no lot on that election's date, the block shows one
  neutral line: "You held no lot on this election's date." That reveals nothing about any lot.
- The block is plain server-rendered HTML with no client directive, per the rendering model in
  `AGENTS.md`.

### 5. The board's amendment flow

**What "amend the turnout record" means.** It uses the existing `setBallots` action on
`POST /api/admin/elections`, with the missed lot added to `entries`. No new action is added. The
Elections panel's Ballots editor already submits the full register
(`src/components/admin/ElectionsManager.tsx`, gated by `can.canEditBallots`). The board also
re-enters tallies with `setTallies` if the physical recount shows the missed ballot was never
counted. Both actions are legal while the election is `closed` (fact 5).

**Engineering change: `setBallots` preserves row identity.** Fact 6 makes today's
delete-and-reinsert unsafe as an amendment. The external contract does not change: it is still a
full replace, the same `400`/`404`/`409` codes, and the same reservation. Inside the reserved
batch, the statements change to set-convergent ones:

1. Reserve, as today.
2. `DELETE FROM ballots WHERE election_id = ? AND property_id NOT IN (…entries) AND <guard>`. An
   empty `entries` deletes every row, which is today's behavior.
3. For each entry:
   `INSERT INTO ballots (…) SELECT … WHERE <guard> ON CONFLICT (election_id, property_id) DO
UPDATE SET weight = excluded.weight, proxy_id = excluded.proxy_id, cast_by_person_id =
excluded.cast_by_person_id`. The conflict target is `ballots_election_property_unq`. The
   upsert never touches `id` or `recorded_at`.
4. Release, as today.

This has four consequences:

- An unchanged lot keeps its `id` and `recorded_at`, so open review flags keep their
  `impacted_ballot_id`, and transfer discovery keeps asking about the real recording instant.
- An amended-in lot gets `recorded_at` set to the amendment instant, which is now a meaningful
  "entered on" fact.
- A lot removed from the register is still deleted, and its flag impact still nulls, which is the
  documented `SET NULL` remedy.
- Two concurrent `setBallots` calls that both add the same lot converge (last writer wins, as
  today) instead of one failing mid-batch on the unique index with a raw D1 error.
  `proxyUsesValidAtMutation` and the proxy/person pre-checks are unchanged.

**Before certification (`closed`).** The board verifies against the physical ballot, amends
through `setBallots` (and `setTallies` if needed), then certifies as normal. If a competing
certify or void lands first, the reservation returns
`409 "Election is certified or void — ballots cannot be changed"` with no partial write (fact 5).

**After certification: uncertify, amend, recertify.** This is the board's rule, and the code
already enforces it: `setBallots` on a `certified` election returns `409`.

1. `uncertify`. This voids the certified terms and office assignments and ends the Board Access
   grants they qualified (fact 7). If a competing uncertify lands first, the second returns
   `409 "Election is no longer certified"`.
2. `setBallots` (and `setTallies`), as above.
3. `certify`. This creates **new** `board_service_terms` rows. `qualifiesGuard` and
   `noOverlapGuard` re-check qualification and non-overlap. A winner who no longer qualifies is a
   hard `409` that names them.
4. **Board Access is re-granted explicitly** through `/api/admin/access-grants`, because a grant
   never resumes automatically and certification never creates one. This is a human step, and
   the panel copy must say so before the uncertify confirmation.

No new state, transition, or affordance flag is needed. `electionAffordances` already offers
exactly this sequence.

**Board-facing copy.** The Elections panel gets a second `<details>` block, "If a homeowner
reports a missing paper ballot", next to "If a result is challenged". It gives the four steps
above and states that correcting a certified result requires uncertifying it, which interrupts
board members' site access until it is re-granted. The existing uncertify confirmation already
points at "the challenge procedure on this panel". Extend it to name both procedures.
`docs/agents/voting-and-ballots.md` gets a matching "Missing paper ballot" subsection under
"Recount and challenge". The two stay in step, as that section already requires.

### Audit

An amendment gets **no new audit-ledger event** in this design.

- The ledger's families are ADR 0022's roster, identity, service, and access facts (fact 8). The
  turnout register is a legacy record table whose correction path is full replacement by design:
  `review_flags` references it `SET NULL` for that reason.
- Adding an `election_record` family means rebuilding `audit_events` to change its CHECK. That is
  a heavy migration on the append-only ledger, and it is not justified by this feature alone.
- Accountability for the amendment comes from the board's procedure, which records the
  verification and correction in the minutes, as the challenge procedure (#303) already does for
  recounts. The preserved row identity in decision 5 also makes `recorded_at` an honest "entered
  on" instant for the amended-in lot.
- The board settled that it does not want an in-app attributable record: minutes only
  ([decision 2](#board-decisions-minutes-2026-09-18)).

## Secrecy analysis

The receipt has to meet three conditions: it cannot become a per-lot turnout oracle, it must
reveal no selection, and it must not weaken ADR 0017 or ADR 0020.

**No selection exists to reveal.** A recorded election stores no link between a ballot and a
candidate anywhere (ADR 0017). `ballot_choices` rows exist only for conducted elections, which
this read excludes by `source = 'recorded'`. The new module never names `ballot_choices` or
`candidate_id`. The static suite pins this (see [Tests](#tests)).

**The caller cannot choose the subject.** The page takes no parameters, and the SQL derives the
lot set from the caller's account through `LOT_SQL`. Widening it means acquiring Lot Authority,
and that requires an Ownership or Representation accepted by the board as a Roster Change.
Automatic Person Verification links an Account to a Person but creates no Ownership
(`CONTEXT.md`). No self-service path exists from "signed in" to "can ask about lot X".

**Multiple lots.** A caller holding several lots gets one row per lot they held on the election
date. Each row answers a question the caller has standing to ask. Holding more lots never
reveals anything about a lot not held.

**Small races and co-holders.** The receipt tells the caller nothing about their own lot that
they did not take part in, with one exception: **another holder of the same lot**. Lot Authority
is equal among all individual Current Owners and all Representatives in scope (`CONTEXT.md`), so
a co-owner learns that "our lot returned a ballot" even if the other co-owner handed it in.

In a race where turnout is one ballot, or the tally is unanimous, that co-owner can then infer
how the lot voted. The residual is accepted and bounded:

- The ballot is the **lot's** ballot, one per lot, and the co-holders share the authority to cast
  it.
- `/vote`'s `hasCast` already discloses exactly this to every holder of a conducted-election lot,
  and conducted tallies are published at close.
- Nothing reaches anyone outside the lot's own holders on the election date.

The spec states this residual plainly rather than claiming anonymity, following ADR 0020's
wording discipline.

**Former and later holders.** The election-date rule stops a buyer from learning the seller's
participation, and a seller from learning anything after the sale. Both see only the period they
held.

**Proxies and provenance.** The receipt omits `proxy_id` and `cast_by_person_id`. Otherwise it
would tell one co-owner that another co-owner gave a proxy or personally cast the ballot. Proxy
holders get no receipt for the granting lot.

**Timing and diffing.** Drafts are never shown, so no one can watch the register being keyed. No
`recorded_at` is exposed. On a `closed` election, a homeowner who reloads could see their own lot
flip from not recorded to recorded after an amendment. That is the purpose of the feature, and it
concerns only their lot.

**Weight.** Weight is not displayed. ADR 0020 names a rare weight as an inference surface for
conducted choices. It is irrelevant to recorded elections, but the receipt has no need of it.

**Nothing new for other tiers.** Visitors and board-without-lots callers see exactly what they see
today. The board's per-lot register stays board-only (`fetchAdminElections`), and
`fetchElectionsFor` still returns `ballots: null`.

## Failure and edge behavior

| Condition                                                       | Result                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Anonymous, unlinked account, or board member who owns no lot    | No receipt block; page otherwise unchanged                   |
| Election `draft`, `void`, conducted, or above the caller's tier | Not on the page; receipt SQL returns zero rows even if asked |
| Caller held no lot on the election date                         | One neutral line, no lot rows                                |
| Election date edited between the two reads                      | Zero rows this render; correct on the next                   |
| Register not yet keyed (`ballotsCast = 0`)                      | "Not entered yet" copy, never "not recorded"                 |
| `cutover_mode = legacy`                                         | No lots, so no rows (fail closed)                            |
| `setBallots` loses to certify or void                           | `409`, register untouched                                    |
| `setBallots` on `certified`                                     | `409` — uncertify first                                      |
| Concurrent `setBallots` adding the same lot                     | Converges; no raw D1 unique-index error                      |
| `uncertify` loses to another uncertify                          | `409`                                                        |
| Recertify where a winner no longer qualifies                    | `409` naming the winner                                      |

## Tests

### Worker/D1 tests: new `test/server/ballot-receipts.test.ts`

- A lot with a `ballots` row returns `recorded: true`. A lot the caller holds without one returns
  `recorded: false`.
- **Scoping:** other lots in the same election, with and without ballots, never appear. Each
  result object's keys are exactly `address` and `recorded`.
- **Election-date authority,** using `seedLotAuthority` with `startDay`/`endDay` set around the
  election date:
  - ownership ended before the election: absent;
  - started after the election: absent;
  - sold after the election while the caller still holds another lot: present;
  - backdated start on or before the election: present.
- **Representation:** organization-wide and lot-scoped scopes both covering the election day are
  present. A Representation that ended before the election day and a voided scope row are
  absent.
- **Parity:** for a fixture set that includes a consolidated duplicate Party and a retired lot,
  the receipt's lot set per election equals `deriveAccess(env, account, electionDate).lotIds`
  intersected with that election. This pins decision 3's "one definition" claim.
- **States:** `draft`, `void`, and conducted `closed`/`certified` elections return zero rows even
  when passed in `elections` directly. `closed` and `certified` recorded elections return rows.
- **Tier:** a homeowner-tier caller passing a `board`-visibility election gets zero rows. A board
  caller who holds lots gets rows.
- **Date guard:** passing a stale `electionDate` yields zero rows.
- A proxy-held lot is absent. The output never exposes `proxyId` or `castByPersonId`.
- An unlinked account and `cutover_mode = legacy` both get an empty map.

### Page tests: extend `test/server/election-pages.test.ts`

The existing suite renders pages through the Container API.

- A caller-class matrix: anonymous, unlinked, member, board with lots, board without lots, and
  System Administrator without lots. Only callers with `member` and a held lot get the block.
  Update `renderAs` to pass `capabilities`/`lotIds`/`personId`.
- The three copy states, the certified "uncertify first" addition, and the `/contact` link.
- `Cache-Control: private, no-store` whenever caller-specific content renders.
- **Flag positive control:** the block renders with `officialMode` off and with
  `liveVotingEnabled` off. This pins decision 2 so a later edit cannot gate it silently.
- The draft and void elections of a caller who holds lots are absent from the HTML.

### `setBallots` identity preservation

In `test/server/admin-elections-board.test.ts`, or a new `admin-elections-amend.test.ts`:

- Amending a `closed` election to add one lot inserts that row and keeps every other row's `id`
  and `recorded_at` byte-identical.
- An open `review_flags` row whose `impacted_ballot_id` names an unchanged ballot keeps it after
  the amendment. A removed lot's flag still nulls.
- Changing only a lot's weight or provenance updates it in place, with the same `id`.
- An empty `entries` still clears the register.
- A `certify` or `void` that wins the race gives `409`, and every row is unchanged. Use the
  existing `pauseNextBatch` fixture pattern.
- Two concurrent `setBallots` calls adding the same lot both return non-`500`, and exactly one
  row exists.
- A `certified` election returns `409`. A conducted election returns `409`. The proxy guard still
  applies.
- **End to end:** `certified` → `uncertify` → `setBallots` → `certify`. The original terms are
  voided, new terms are created, the Board grant ended with `recorded_in_error` stays ended, and
  the amended lot's receipt reads `recorded: true`.
- **Transfer effects** (`test/server/transfer-effects.test.ts`): a backdated ownership end whose
  window covers an amendment flags only the amended-in lot's ballot, not every ballot of the
  election.

### Static and structural suites

- **`test/unit/ballot-privacy-boundary.test.ts`:** add `server/content/ballot-receipts.ts` to
  `MACHINERY`. It may not name `ballot_choices`, `ballotChoices`, `candidate_id`, or
  `candidateId` in code, and may not name the candidate terms even in comments.
- **`test/unit/legacy-roster-consumers.test.ts`:** no entry is added. The new module reads no
  dropped table, and the suite fails if it ever starts to.
- **`test/unit/affordances.test.ts`:** unchanged, because no affordance changes. Keep the
  existing `canEditBallots`/`canUncertify` rows as the pin that the amend path stays offered.
- **`admin-routes-all-gated.test.ts`, `member-routes-all-gated.test.ts`, and
  `permission-matrix.test.ts`:** **no new rows, deliberately.** These suites enumerate API route
  modules, and this design adds none. `setBallots`, `uncertify`, and `certify` are verbs on the
  existing `/api/admin/elections` module, which is already enumerated as `board`-declared (member
  → `403`, unlinked → `403`, board admitted). The receipt's caller-class coverage is the page
  matrix above. If a later change adds a receipt API route, it must declare `member`, go through
  `requireMemberApi`, and be picked up by both enumerating suites automatically through their
  recursive globs.

### Gates

Each slice runs `format:check`, `sync:agents -- --check`, `lint`, `lint:coercions`,
`lint:fixtures`, `check`, `test`, `test:server`, and `build`. Fixtures use synthetic addresses and
reserved contact values only.

## Delivery slices

1. **`setBallots` identity preservation.** Convert to the set-convergent statements, with the
   identity, flag, race, and transfer-effects tests. This is independently valuable, since every
   board correction benefits, and safe to merge alone because the external contract is unchanged.
2. **Receipt read and page.** Add `ballot-receipts.ts`, the `/elections` block and cache header,
   the page matrix, and the privacy-boundary entry.
3. **Board procedure copy and docs.** Add the Elections panel `<details>` block and updated
   uncertify confirmation. Update `docs/agents/voting-and-ballots.md`, `http-endpoints.md`
   (the `setBallots` statement shape), `module-map.md`, and `data-model.md` through
   `docs-updater` at ship.

This design narrows ADR 0017's "per-lot turnout is board-only" to "board-only, except that a lot's
own holders on the election date see that lot's status". That narrowing is recorded in
[ADR 0026](../adr/0026-paper-ballot-receipt-for-own-lot.md).

Slice 3's uncertify-then-regrant step is an operator step for the board only if it is ever used.
It is documented in panel copy and does not need a follow-up issue at ship.

## Out of scope

- Receipts for conducted elections after close, and any conducted amendment. Conducted ballots
  are final, and a void and re-run is the remedy.
- Receipts for callers with no current `member` capability, such as a former owner who holds no
  lot today. They contact the board.
- Receipts for proxy holders.
- Homeowner-submitted disputes, notifications when a register is entered or amended, and any
  homeowner write.
- An audit-ledger family for election-record corrections.
- Repointing `/vote`'s `user_property_links` scoping to derived access. That is phase 4's
  `needs-repointing` work (#212), not this feature.

## Board decisions (minutes 2026-09-18)

The three policy questions this design left open are answered. Every engineering default stands,
and two of them describe behaviour that was already live: slices 1–3 shipped in v1.1.3 and v1.2.0
earlier the same day, before these decisions were taken. No engineering change follows from any of
the three.

1. **Former holders who no longer hold any lot.** No — they contact the board. This confirms the
   shipped behaviour rather than changing it: the `member` capability is derived only for a caller
   holding at least one lot on the current Association Day, so an owner who has sold every lot
   gets no receipt block at all. It agrees with the equivalent decision on
   [ADR 0024](../adr/0024-lot-records-per-lot-private-audience.md), so a former owner loses access
   at transfer on every surface under one rule.
2. **An attributable in-site record of amendments.** Minutes only. The site records no attributable
   event for a turnout amendment, which is the shipped behaviour — the audit ledger has no election
   family, and adding one would mean rebuilding the append-only `audit_events` table to change its
   CHECK constraint. Since slice 1 an amended-in lot's `recorded_at` is an honest "entered on"
   instant, so the record shows _when_ a lot was added, though never by whom.
3. **A dispute window before certification.** Adopted as **board practice, not software**. The
   board publishes the period and does not certify until it has passed. That gets the benefit the
   question was after — fewer uncertifications, which matter because uncertifying voids the terms
   certification created and ends the Board Access those terms qualified, and that access never
   resumes automatically — without adding a new election state or a new way for a certification to
   be stuck. The Elections panel's existing missing-paper-ballot procedure already describes the
   correction path.
