# ADR 0028: Tenant Access Is a Tenancy Beside Lot Authority, Seeing Only Documents Marked for Tenants

**Status:** Accepted 2026-10-20; amended 2026-10-26 (see [Amendments](#amendments))
**Date:** 2026-10-20

## Context

#294 asks for accounts for tenants: people who live in the neighborhood without owning a Lot. The
site has no caller class for them. Under [ADR 0022](./0022-party-roster-derived-access.md) an
account's access comes only from its linked Person's Current Ownerships and Representations (Member
Access), or from an Access Grant (Board and System Administration Access). A tenant holds none of
these. [ADR 0001](./0001-possession-based-homeowner-verification.md) already noted that tenant access
would need its own policy, because Automatic Person Verification proves a match to a Current Owner.

The board answered the policy questions at its 2026-08-11 meeting (recorded on #294):

1. Access is **owner-invited and board-approved**: the owner initiates, and the board gives final
   approval.
2. Tenants see **public content plus the homeowner-tier documents the board explicitly marks** as
   relevant to residents, such as the architectural rules and amenity policy, and not the rest of
   the homeowner tier.
3. Access is **fixed-term**, with an end date such as the lease end, renewable, and it also **ends
   automatically when the underlying Ownership ends**.

The issue guessed that a tenant would be "a Representation with its own type". The code argues
against that guess, for two reasons:

- **The shape does not fit.** A Representation is a Person acting for an **Organization**:
  `representations.organization_party_id` is `NOT NULL` and references `organizations`, and most
  tenants rent from a person.
- **Representations grant Lot Authority.** Every reader of Lot Authority counts every live
  Representation: `derive.ts`'s `LOT_SQL`, `roster/authority.ts`'s readers and its
  `lotAuthorityExists` fragment, and `board-consequences.ts`'s `qualifiesGuard`. A tenant type would
  need an exclusion in each of them, and in every future reader. A reader that forgot one would hand
  a tenant voting, proxies, Lot Records and Board eligibility. That fails open.

## Decision

### A Tenancy is its own relation, which no Lot Authority reader joins

A **Tenancy** is a time-bounded relationship between a Person and a Lot. It lives in its own table,
`tenancies`, and grants **Tenant Access** only. It never grants Lot Authority or Member Access.
Lot Authority readers do not change: they never join `tenancies`, so a tenant cannot reach a Lot
Authority surface through a missing exclusion. A test in the style of
`test/unit/legacy-roster-consumers.test.ts` pins that `roster/authority.ts`, `LOT_SQL` and
`board-consequences.ts` never name the table.

A Tenancy records:

- the tenant Person;
- the Lot;
- the **basis Ownership** (see below);
- a `start_day`;
- a required exclusive `end_day`;
- an `ended_day` and reason for an early end;
- `voided_at` for one recorded in error.

Interval non-overlap per Person per Lot is conditional SQL at the mutation boundary, as it is for
Ownerships. A Person may hold Tenancies of several Lots, and may be an Owner elsewhere at the same
time.

**Renewal is a new, adjacent Tenancy**, as a renewed Board Term is. Each row's term stays bounded,
and the history keeps every term the board approved.

### Who may be a tenant: a roster Person with a Person Link

A tenant is a Person on the roster. A tenant's account reaches Tenant Access through a Person Link,
like any other account. Board approval creates the tenant's Person and the Contact Method the owner
supplied, or names an existing Person when the tenant is already on the roster, for example an
Owner of another Lot or a former owner. Those are Roster Changes, accepted by the board like any
other.

Because tenants become roster People, the AI pseudonymizer's `loadRosterEntries` masks their names
and contacts with no change. The change that builds this updates the `/privacy` page, since the site
then collects tenants' names and contact details.

### How a tenant is admitted: owner request, board approval, then the tenant's claim

1. **The owner requests.** Any account holding Lot Authority over the Lot may request a Tenancy. That
   covers a direct owner, and a Representative of an organizational owner such as a property
   manager. The request gives the tenant's name, one email address or phone number, the Lot, and the
   end day. It is a request, not a roster fact, matching the rule that member-submitted information
   remains a request until accepted. Requests live in their own table with a status and, when
   refused, a reason.
2. **The board approves or refuses.** Only a System Administrator, or a current Board Member with
   Board Access, decides, the same authority that accepts any other Roster Change. Approval re-checks
   inside its mutation batch that the requester still holds Lot Authority and the basis Ownership is
   still current. If either has changed, it answers `409` rather than writing. One audit correlation
   records the Person (when new), the Contact Method and the Tenancy as Roster Changes. The Tenancy
   starts on the approval's Association Day; there is no backdating, because a Tenancy grants
   nothing before the tenant can sign in.
3. **The tenant claims.** Only after approval is a single-use invitation link sent to the approved
   contact. The link carries a 256-bit random token, good for 14 days, stored only as an HMAC under
   the same secret as the verification codes and sent through the same senders. The tenant signs in
   to their own account, or creates one, and claims from the page the link opens; opening the page
   never consumes the link. The claim creates the Person Link, recorded as an Identity Event. It
   lives beside the `/api/verify/*` routes, under their write-freeze guard. A fresh link can be sent
   without a new approval, by the board or any holder of Lot Authority over the Lot, at most three
   a day per Tenancy. An account already linked to a different Person cannot claim; an account already
   linked to the tenant Person needs no claim, because the Tenancy applies to it at once.

Nothing is sent to anyone the board has not approved. Automatic Person Verification is not used,
because a tenant's contact is not on file until the board accepts it; the claim code proves control
of the contact the board accepted.

### The term: a required end day, at most 13 months out

The end day is required and may be at most 13 months after the start day: a year's lease plus some
room. A request or approval beyond that is refused. A renewal is a new request through the same
owner-request and board-approval path. It needs no new claim, because the Person Link already exists.

### The basis is the owning party's Ownership, and its end ends the Tenancy

The **basis Ownership** is the Current Ownership of the party that owns the Lot on the tenant's
behalf. For a direct owner's request, it is that owner's Ownership. For a Representative's request,
it is the represented Organization's Ownership, not the Representative's Representation. A property
manager who leaves the management company therefore does not cut off the tenants they admitted,
while any change of owner ends the Tenancy. Among co-owners, the basis is the requesting co-owner's
own Ownership, so a co-owner selling their share ends the Tenancies they admitted, while the
remaining co-owner may request a new one.

The rule is enforced twice, following ADR 0022's rule that evaluation never trusts the write path:

- **On every request.** A Tenancy confers Tenant Access only while it is current, its basis Ownership
  is current and unvoided, and its Lot is not retired.
- **At the mutation boundary.** Ending, voiding or transferring the basis Ownership ends the Tenancy
  in the same batch, as a consequence linked to the initiating Roster Change. Retiring the Lot ends
  it too. This is the pattern `lossConsequences` already follows for Board Terms.

**Ending early needs no approval.** Ending access is always the safe direction, so these may end a
Tenancy before its end day, with a reason, without board approval:

- any current Lot Authority holder over the Lot;
- the board.

The tenant may end their own access by ending their Person Link, which the linked account can
already do. A Tenancy that ends leaves the Person and the Person Link in place. The account simply
has no Tenant Access, as a former owner keeps a Person Link and loses Member Access.

### Tenant Access: derived per request, a capability and not a content tier

`deriveAccess` gains a third statement in its batch, selecting the caller's current Tenancies under
the conditions above. Any row adds a `tenant` capability. `tenant` satisfies no existing guard:
`requireMemberApi` and the member pages check `member`, and the board surfaces check `board`.

A tenant's `contentTier` stays `visitor`, and the ladder `visitor < homeowner < board` does not gain
a rung. `tierAllows` and `visibleTiers` are unchanged, so announcements, meetings, resolutions,
elections and every other content type show a tenant exactly what they show the public, as the
board decided, with no new code on those paths.

### Documents are marked for tenants with a flag on the homeowner tier

`documents` gains a **Tenant-Visible** flag. A CHECK allows it only on a `homeowner` document: a
public document needs no flag, and a board document can never carry one. Changing a document's
visibility away from `homeowner` clears the flag in the same statement. Uploads and Drive Imports
start with it off. Only the board sets or clears it, through the documents admin.

A tenant sees public documents plus Tenant-Visible ones. That is one added clause, shared by the
document list (`fetchDocumentsFor`, for `/documents` and `/api/content/documents`) and the download
gate in `/api/files/[id]`: _or the document is Tenant-Visible and the caller holds `tenant`_. Any
future non-board document read uses the same predicate. A Tenant-Visible-only document a non-tenant
asks for still answers `404`, never `403`.

The AI assistant and reports stay board-only, so the AI Search index, which is not tier-aware, is
unaffected.

### Two gates: official mode, and its own audited flag

Tenant requests are homeowner writes under `/api/member/`, so
[ADR 0019](./0019-homeowner-writes-official-mode-gate.md) already gates them on `officialMode`. A
second site setting, `tenantAccessEnabled`, defaults to off and changes only through the audited
setting-change path (#363, `setting_changes`), never through the whole-blob `PUT /api/admin/site`.
It works the same way as `lotRecordsEnabled` in [ADR 0024](./0024-lot-records-per-lot-private-audience.md).
Adopting the site therefore does not open tenant accounts before the board has marked any documents
for tenants.

Requests, approvals and claims need both gates on, re-checked inside their mutation SQL. While
either gate is off, the document predicate's tenant clause does not apply, so no tenant sees
anything beyond the public site. Ending or voiding a Tenancy, refusing or withdrawing a request, and
an owner ending a Tenancy stay available while the gates are off, because ending access must never
wait on a gate, and a pending request's name and contact must always be clearable. None of them
grants anything. The owner's actions still need official mode, like every homeowner write.

### What tenants never get

Tenant Access is read-only. A tenant has no Member Access, no Lot Authority, no Lot Records, no
proxies, no voting, no correction requests and no owner directory. `permission-matrix.test.ts`
gains a tenant caller class asserted to be refused by every member and board route.

## Consequences

- The roster gains a fourth relationship beside Ownership, Representation and Board Term. Lot
  Authority, voting weight, quorum and Board eligibility are unchanged by construction.
- The document read and the download gate stop being a pure tier comparison. Both take the caller's
  capabilities as well as `contentTier`, and must share one predicate so the list and the download
  cannot disagree.
- Ownership end, void, transfer and Lot retirement gain a Tenancy consequence, and the invariant
  gate gains a check that no current Tenancy rests on an ended or voided basis Ownership.
- The board takes on an approval queue, and the work of marking which documents tenants see. Nothing
  is visible to a tenant until it has done the second.
- Nothing ships to production use until the board adopts the site (#361) and separately turns on
  `tenantAccessEnabled`. Development proceeds against local D1 with synthetic data.

## Amendments

**2026-10-26 (#294 slice 4).** Two sentences changed, both recorded as departures in the
[design spec](../specs/2026-10-20-tenant-access-design.md#departures-from-adr-0028) and accepted by
the maintainer:

1. **The claim uses a single-use link, not the 6-digit code.** A code is safe because it lives ten
   minutes, allows five attempts and is bound to the account that asked for it. An invitation is
   sent before the tenant has an account, must last days in an inbox, and is claimed by whichever
   account the tenant signs in with, so a 6-digit code with that lifetime and no binding could be
   guessed. The HMAC and its secret, and the email and SMS senders, are reused unchanged. The limits
   are new KV counters of the same kind as the verification send limits, keyed by Tenancy (three
   sends a day) and by account (five claim attempts a day). The claim has no Turnstile step: it is
   reached only by following a link the board's approval sent, and a 256-bit token is not
   guessable.
2. **More actions stay live with the gates off.** The board's refusal and the owner's end and
   withdrawal join the board's end and void, for the same reason, and so that a pending request's
   name and contact can always be cleared.

## Related decisions

- [ADR 0001: Possession-Based Homeowner Verification](./0001-possession-based-homeowner-verification.md)
- [ADR 0002: Tiered Content and Document Storage](./0002-tiered-content-and-document-storage.md)
- [ADR 0019: Homeowner Writes Are Official-Mode Gated](./0019-homeowner-writes-official-mode-gate.md)
- [ADR 0022: A Party Roster Separates Identity, Ownership, Representation, Service, and Access](./0022-party-roster-derived-access.md)
- [ADR 0024: Lot Records Are a Per-Lot Private Audience, Not a Fourth Content Tier](./0024-lot-records-per-lot-private-audience.md)
