# ADR 0025: A Per-Lot Dues Ledger, with Online Payments Reconciled from Verified Provider Events

**Status:** Proposed
**Date:** 2026-09-17

## Context

Dues today are presentation only. The `dues` settings singleton (`DuesSettings` in
`src/lib/types.ts`) holds a free-text `amount`, `dueDate`, `notes`, and a list of
`paymentOptions` links. `PUT /api/admin/dues` replaces it, and `/dues` renders it only in official
mode. Nothing records what a Lot owes, what it has paid, or when. The site has never moved money
and has never held a fact that a homeowner could contradict with a bank statement.

The board approved #295 (online dues payments) at its 2026-08-11 meeting, taking effect once the
site is officially adopted (#361). It selected the provider on 2026-09-18: **Stripe**, using
hosted Checkout, ACH Direct Debit by default with card optional, and signed idempotent webhooks.
Fees differ little at this scale, so what decided it was that the alternative — a bank lockbox —
means the board hand-enters every payment indefinitely, and ledger accuracy then depends on that
typing, where the design below credits only from a verified provider event. The issue fixes two
requirements: payments need their own flag separate from `officialMode`, and "the reconciliation
design matters more than the checkout flow". It also names the new failure class: a homeowner who
believes they paid and a ledger that says otherwise.

**The association is self-managed.** The document corpus holds a large body of material from a
previous management company, including an owner portal that took payments, and a reader coming to
that corpus cold would reasonably read it as current. It is not. The rail described here is the
association's only one; it neither duplicates nor competes with a manager's portal.

ADR 0024 establishes Lot Records, the per-Lot private audience this ledger belongs to.

## Decision

### An append-only per-Lot ledger in integer cents

`dues_ledger_entries` is a Lot Record type under ADR 0024. Each row has:

- `lot_id` referencing `properties.id`
- `kind` (`charge` / `payment` / `adjustment` / `reversal`)
- signed `amount_cents` as an INTEGER
- `effective_day` (Association Day)
- homeowner-visible `description`
- `category` for charges (`assessment` / `special_assessment` / `late_fee` / `fine` / `other`)
- `method` for payments (`online` / `check` / `cash` / `other`)
- board-only `reference`, such as a check number
- `source` (`board` / `provider`)
- nullable `payment_id` (below)
- nullable `reverses_entry_id`
- `recorded_by` (account, `NULL` for provider-sourced rows)
- `recorded_at`
- a unique `operation_key`

The signs are fixed by CHECK constraints, so the balance is a plain sum: a charge is positive, a
payment is negative, an adjustment is non-zero, and a reversal is non-zero with a non-null
`reverses_entry_id`. That column is present exactly when `kind = 'reversal'`, and it is UNIQUE, so
an entry can be reversed at most once. The reversal's amount is exactly the negation of the
original, and a reversal cannot itself be reversed. Neither rule is a same-row CHECK, so both are
enforced inside the `INSERT … SELECT` that writes the reversal. A lost race writes nothing and
answers `409`.

**Money is never a float, and never a string parsed with `||`.** Amounts cross the API as integer
cents. Form input goes through the blank-first rule in `AGENTS.md`, and `0` is rejected rather
than defaulted.

**Entries are never updated or deleted.** A mistaken entry is corrected by a `reversal` and, if
needed, a new correct entry. A real-world credit or debit, such as a board-approved waiver, is an
`adjustment`. No route issues `UPDATE` or `DELETE` against the table. As with the ADR 0022 ledger,
that is a discipline pinned by integration tests, not a trigger. The **balance is derived**, never
stored: `SUM(amount_cents)` over a Lot's entries. A positive balance is owed, and a negative
balance is a credit. There is no balance column to drift.

The ledger is **balance-forward**. Payments are not allocated to specific charges. Open-item
accounting (which payment settled which assessment) is deferred; the treasurer's books remain the
place that allocation lives. The existing `DuesSettings` blob stays as the public description of
dues amounts and offline options. The ledger does not replace it.

**A partial payment applies in the association's adopted order: attorney fees, then fines, then
late fees and interest, and lastly assessments** (board, minutes 2026-09-18). That order comes
from the association's adopted collection policy, which makes it a constraint on this ledger
rather than a preference — a naive assessments-first application would put the site at odds with
the association's own policy. Balance-forward is what keeps the first slice consistent with it:
because no entry claims to settle another, the ledger asserts no allocation at all, and no surface
may present one. When open-item accounting is taken up, this order is a fixed input to that
design, not a choice left to it.

Board charge posting includes a bulk action that posts one assessment to every non-retired Lot in
one D1 batch under one `operation_key`, so a double submit posts nothing twice.

### Offline payments share the ledger

A check, cash, or bank-transfer payment the board receives is a `payment` entry with
`source = 'board'`, the appropriate `method`, and an optional `reference`. It is idempotent by
`operation_key`. There is one ledger, not an online ledger and a paper one. The homeowner sees both
the same way.

### A provider-agnostic payment model; the provider is an adapter

Three tables, none of which names a provider in its schema:

- **`payments`**: one attempt by a party to pay a Lot. It holds `lot_id`, `amount_cents` (> 0),
  `initiated_by_person_id`, `provider` (an adapter id, a plain string), a UNIQUE nullable
  `provider_payment_ref`, and `status` (`created` / `pending` / `succeeded` / `failed` /
  `canceled` / `expired`). It also holds `ledger_state` (`none` / `credited` / `withdrawn`),
  `created_at`, and `updated_at`. `status` and `ledger_state` are operational projections for
  display and for the reconciliation job. The ledger remains the authority for money.
- **`payment_events`**: every verified fact received from a provider, normalized. It holds
  `provider`, `provider_event_id` (UNIQUE together with `provider`), a nullable `payment_id`,
  `type`, `amount_cents`, `currency`, `occurred_at` (the provider's time), `received_at`, `via`
  (`webhook` / `reconciliation`), and `outcome` (`applied` / `duplicate_effect` / `unmatched` /
  `exception`). The raw provider payload is **not** stored, because it carries payer names,
  emails, and bank details the association does not need. Only the normalized fields above are
  kept.
- **`payment_exceptions`**: the board's queue for anything the automatic path refused to decide.
  It holds `payment_event_id` or `payment_id`, a `reason` code, and `opened_at`. Resolution is
  recorded by an appended resolution row, never by editing the opening row.

The normalized event `type` vocabulary is the whole contract between the adapter and the rest of
the system:

| Type                | Meaning                                                  | Ledger effect                                                             |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `payment_pending`   | Accepted by the provider; funds not yet settled (ACH)    | None                                                                      |
| `payment_succeeded` | Funds confirmed                                          | One `payment` entry for the confirmed amount                              |
| `payment_failed`    | Failed before success                                    | None                                                                      |
| `payment_canceled`  | Abandoned or expired checkout                            | None                                                                      |
| `funds_withdrawn`   | ACH return, refund made at the provider, or lost dispute | One `reversal` of that payment's entry, plus an exception                 |
| `funds_reinstated`  | Dispute won after a withdrawal                           | One new `payment` entry (never an un-reversal), plus exception resolution |
| `dispute_opened`    | Informational                                            | None; opens an exception                                                  |

The adapter lives in `src/server/payments/providers/<id>.ts` and implements one interface. It
creates a hosted checkout for a `payments` row and returns a redirect URL. It verifies and parses
a webhook request into zero or more normalized events. It retrieves the current state of one
payment by reference, and it lists events since a cursor. **Nothing outside the adapter directory
imports a provider SDK or names a provider.** A unit scan pins this, in the style of
`authz-legacy-role.test.ts`. The selected provider is configuration: a `PAYMENTS_PROVIDER` var
naming the adapter id. Stripe is the first adapter, chosen by the board on 2026-09-18. Because the
provider stays behind this boundary, that choice is reversible without moving schema, ledger,
gates, or board surfaces. Nothing in this decision depends on it.

### A payment is recorded only from a verified provider fact

The browser redirect back from hosted checkout is **never** evidence of payment. Its query
parameters are not read for state. The return page shows "processing". It may ask the server to
reconcile that one payment, and the server does so by pulling from the provider's API with the
secret key. That pull is as trustworthy as a webhook and goes through the same idempotent
application path.

Idempotency is enforced **twice**, because it is needed twice:

1. **Per event:** `UNIQUE(provider, provider_event_id)` on `payment_events`. A redelivered webhook
   is stored once and answered `200`.
2. **Per effect:** a `payment` entry is UNIQUE per `payment_id` for `source = 'provider'`, and a
   reversal is UNIQUE per reversed entry. One real-world settlement can arrive as several distinct
   provider events. It can also arrive once by webhook and again by the reconciliation pull, under
   different ids. Event-id uniqueness alone would credit it twice, so effect uniqueness makes every
   path converge on one entry. A later event whose effect already exists is stored with
   `outcome = 'duplicate_effect'`.

Event storage, the `payments` projection update, the ledger entry, and any exception row are
**one D1 batch**. Either the fact and all its consequences land, or nothing does and the webhook
answers non-2xx so the provider retries.

**Order tolerance.** ACH events can arrive out of order. The `payments.status` projection follows
a precedence rule: a terminal state is never overwritten by an earlier-stage event, and a
`payment_pending` arriving after `payment_succeeded` is stored and changes nothing. Ledger effects
are keyed by fact, not by arrival order.

**Mismatches become exceptions, not guesses.** Money that actually moved is still recorded. An
event whose amount differs from the `payments` row is credited at the amount the provider confirms,
and an exception opens. A non-USD event is not credited and opens an exception. An event matching
no `payments` row, such as a payment taken in the provider's own dashboard, is stored as
`unmatched` with no ledger effect. The board can apply it to a Lot through an admin action that
writes the `payment` entry citing the event. That action is once-only through the same effect key.

### The ledger outlives the flags

Turning `onlinePaymentsEnabled` (or `officialMode`) off stops **new** checkouts and hides the pay
action. It does not stop ingestion. A homeowner whose ACH debit was initiated yesterday will settle
or return next week, and that fact must be recorded whether or not the site is still taking new
payments. Webhook ingestion and the reconciliation job therefore depend only on the provider being
configured (the secrets below). They do not depend on any site flag.

### Gates

`onlinePaymentsEnabled` is a new site setting, default `false`, normalized as literal
`=== true`. It is written only through ADR 0024's audited flag action, never by the blob `PUT`.
Starting a checkout requires **all three** of `officialMode`, `lotRecordsEnabled`, and
`onlinePaymentsEnabled`. The mutation SQL that inserts the `payments` row re-checks all three, plus
Lot Authority through `lotAuthorityExists`. A payment the payer could not then see on the ledger
would be incoherent, and adopting the site or publishing Lot Records must not implicitly turn on
money movement.

Starting a checkout is `POST /api/member/payments`, a homeowner write. Its per-route guard follows
`requireVotingApi`'s order: the three flags (`404`), the write freeze (`503`), exact `Origin`
(`403`), JSON media type (`415`), session (`401`), `member` (`403`). Then the requested Lot is
checked inside the insert (`404` when the caller lacks authority, never `403`). The amount is
positive integer cents, defaulting in the UI to the current balance and capped by a server
constant. An overpayment becomes a credit balance. The route answers with the provider's hosted
checkout URL as JSON, and the client navigates to it. A form post that redirects cross-origin is
avoided because the enforced CSP sets `form-action 'self'`. Hosted redirect checkout needs no CSP
change. Embedded checkout would need new `script-src` and `frame-src` origins and is rejected.

The middleware `/api/member/*` backstop gains the three-flag check for this path, and
`member-routes-all-gated.test.ts` and `permission-matrix.test.ts` seed the flags for it, as
ADR 0024 describes for Lot Record routes. Board ledger and payment routes live under
`/api/admin/` with ADR 0024's board-first order.

### The webhook endpoint: signature-authenticated, outside every session namespace

The provider calls `POST /api/webhooks/payments`. Its placement relative to the existing rules is
deliberate:

- **Not under `/api/admin` or `/api/member`.** Both backstops would answer `401` to a caller with
  no session. The provider has no session, and its authentication is the signature.
- **Middleware.** The path falls through to `src/middleware.ts`'s final `else` branch, which
  applies only `writeFreezeError`. No new middleware branch is added. A backstop cannot usefully
  check a signature without re-implementing the adapter. Session resolution still runs there,
  finds no session, and is harmless.
- **Per-route authentication is the adapter's verification**, done first. The route reads the raw
  body as text, which is the one deliberate exception to `readJson`, because signature
  verification needs the exact bytes. It verifies with `PAYMENTS_WEBHOOK_SECRET`, and only then
  parses. With no secret configured it answers `404`. With a missing or invalid signature, or a
  stale timestamp, it answers `400` and stores nothing.
- **All-gated suites do not reach it**, because they glob `api/admin` and `api/member`. So
  `/api/webhooks/` gets its own enumeration suite. Every exported verb of every module there must
  answer `400` to an unsigned request once a secret is configured, and `404` with none. A webhook
  shipped without verification fails the build, which is ADR 0013's reasoning applied to a
  different authenticator. `GET` and every other verb besides `POST` are not exported.
- **Write freeze: covered, not exempt.** `freezePolicyFor('/api/webhooks/payments')` is
  `mutations`, so a delivery during a freeze answers `503`. That is correct. A freeze exists so no
  write lands mid-maintenance, and ledger writes are exactly the kind that must not. Providers
  retry non-2xx deliveries with backoff, which is a stated requirement on any adapter's provider.
  A freeze longer than the provider's retry window is covered by the reconciliation job.
  `freeze-coverage.test.ts` needs no change, and **no named exemption is requested**. Adding one
  would make this the third `ALWAYS_LIVE` entry, and the case for it does not meet that list's bar.

### Reconciliation job

A new independent job in `runScheduledJobs` (`src/server/scheduled.ts`) runs daily on the existing
`0 7 * * *` trigger in its own `try` block. It pushes to `failures` on error, so a provider outage
cannot hide an invariant violation, and vice versa. It does two things through the adapter:

1. For every `payments` row in `created` or `pending` older than a threshold, it retrieves the
   provider's current state and applies it.
2. It lists provider events since a stored cursor, kept in a small operational singleton, and
   ingests them with `via = 'reconciliation'`.

Both paths use the same idempotent application path, so a missed webhook is recovered and a
delivered one is a no-op. The job logs counts and ids only.

Payout reconciliation — matching provider deposits to the association's bank statement — is the
treasurer's work outside the site. The board surface offers a per-period export of provider-sourced
entries to support it.

### "I paid, and the ledger says I didn't"

The homeowner surface lists the Lot's `payments` with status, amount, date, and the provider's
reference, the same one on the provider's emailed receipt. A homeowner who believes they paid can
quote it. The board's per-Lot payment view shows each `payments` row with its normalized
`payment_events`, the ledger entry it produced if any, and any open exception. From there the
board can trigger a re-sync of one payment, which is the reconciliation pull on demand.

The investigation then has three outcomes:

1. **The provider confirms success.** The pull records the entry. The discrepancy was a missed or
   delayed event, and it is now closed with an audit trail.
2. **The provider shows pending, failed, or returned.** The ledger is right. The homeowner is
   shown the provider's status and, for a return, the reversal entry.
3. **The provider has no such payment.** The homeowner paid some other way, or not at all. The
   board records any offline payment it can substantiate as a `board` entry with a reference.

A board-entered payment has no provider key. If a provider payment for the same Lot and amount
later arrives within a window, it is still credited — the money moved — and a
`possible_duplicate` exception opens for the board rather than being silently blocked.

### Secrets and PCI scope

Card and bank-account numbers never reach the Worker. Hosted checkout collects them on the
provider's domain, which keeps the association at the lightest PCI self-assessment scope
(SAQ A). The middleware's `Permissions-Policy: payment=()` stays as it is, because it governs this
origin, not the provider's page. `PAYMENTS_API_KEY` and `PAYMENTS_WEBHOOK_SECRET` are Worker
secrets, with provider-neutral names. They are declared in `src/ambient.d.ts`'s `Env` augmentation
and `.dev.vars.example`, and deployed with `npm run secrets:put`. Setting them is a production
secret change that needs explicit confirmation. The merchant account those secrets belong to is
the association's, never the site operator's.

The board settled that account's ownership on 2026-09-18: the **treasurer** opens it, in the
association's name, under its EIN and settling to its bank account — never a personal account.
Its credentials live in the association's password manager rather than an individual's, and a
second officer holds recovery access, so a single departure cannot strand it. Until the account
exists there are no credentials, so this rail can be built to the adapter boundary but not
integrated; the account itself is an operator step tracked on the private tracker
(`jwh3times/valleys-at-ashebrook-hoa-ops#34`).

### Deliberately out of scope

Each of these is **deferred**, not rejected, and each would be a later decision:

- Autopay and subscriptions.
- Automatic late fees and interest. The board posts `late_fee` charges manually. When automatic
  late fees are taken up, the amount, grace period, and lien threshold must be read from the
  association's **executed** collection policy rather than invented here: the corpus copy is a
  scanned form whose fee fields did not survive OCR, and reading the original is tracked on the
  private tracker (`jwh3times/valleys-at-ashebrook-hoa-ops#33`).
- Payment plans.
- An automatic returned-payment charge. The ledger reverses a returned payment on its own, and
  the board decided (minutes 2026-09-18) that any fee for it is posted as a ledger entry by the
  board rather than charged automatically.
- Refunds initiated from the site. A refund made in the provider's dashboard arrives as
  `funds_withdrawn` and is reversed automatically. The board decided (minutes 2026-09-18) that
  refunds are authorized by the **treasurer, outside the site**, and recorded as a matching ledger
  entry, so no money-moving path is added to the admin surface.
- Charge-level payment allocation — deferred, but no longer open-ended: when it ships it follows
  the adopted payment-application order above.
- Emailed statements or dunning notices.
- Linking fines to ADR 0024 violation records.
- Any provider fee accounting on the Lot ledger. Provider fees are an association expense, not a
  Lot charge. The board decided (minutes 2026-09-18) that the association **absorbs** processing
  fees, with no card surcharge — so no surcharge rules and no counsel review enter this design,
  and the lever if cost becomes a concern is steering payers to ACH.

## Consequences

- The site gains a financial record whose authority is structural. The balance is a sum, not a
  stored number. Corrections are visible compensating entries. Every provider-sourced credit traces
  to a verified event or an authenticated pull.
- Choosing, or later changing, the provider is an adapter and a configuration change. Schema,
  ledger, gates, and board surfaces do not move.
- A frozen site delays payment recording without losing it. A webhook outage delays it by at most
  a day. Neither can double-credit.
- Board data entry for checks, bulk assessments, and exception resolution is new recurring work.
  The design makes it recordable and reviewable, not automatic.
- The site holds association financial data. That raises the stakes of the existing controls: the
  write freeze, Board Access revocation, and D1 backup and Time Travel. It also adds a production
  secret pair whose rotation is an operator task.
- New structural suites: webhook enumeration, the provider-name scan, ledger insert-only, effect
  idempotency under redelivery and under webhook-plus-pull, and order tolerance.

## Board decisions (minutes 2026-09-18)

The seven policy questions this ADR left to the board are answered, including the provider choice
it deliberately left open. They are numbered here as this ADR numbered them; the minutes and the
answers recorded on #295 number the same seven 6 through 12, continuing ADR 0024's list.

1. **Provider.** Stripe, with ACH as the default method. A bank lockbox was weighed and rejected:
   it would mean hand-entering every payment indefinitely. The provider remains an adapter, so the
   choice is reversible.
2. **Merchant account ownership.** Opened by the treasurer, in the association's name, EIN, and
   bank account — never a personal account. Credentials in the association's password manager,
   with a second officer holding recovery access.
3. **Who bears fees.** The association absorbs processing fees. No card surcharge, so no counsel
   review on surcharging is needed. The lever if cost becomes a concern is steering payers to ACH.
4. **Payment methods offered.** ACH by default, card optional.
5. **Partial payments and overpayments.** Both allowed; an overpayment becomes a credit. **A
   partial payment applies in the association's adopted order — attorney fees, then fines, then
   late fees and interest, and lastly assessments.** This is a binding constraint on the ledger,
   recorded with the ledger design above.
6. **Returned payments.** No automatic charge. The ledger records the reversal; the board may post
   a fee as a ledger entry.
7. **Refunds.** Authorized by the treasurer, outside the site, recorded as a matching ledger
   entry.

**What is still needed before the fee behaviour can be built.** The executed collection policy
supplies the payment-application order above, which is legible in the corpus, but its late-fee
amount, grace period, and lien threshold are not. The corpus copy is a scanned form of processing
instructions whose checkbox selections and fee fields did not survive OCR, so those figures must be
read from the executed original before anything implements them. That reading is tracked on the
private tracker (`jwh3times/valleys-at-ashebrook-hoa-ops#33`). No figure is invented here.

This ADR remains **Proposed**. These answers clear the policy questions and the provider choice;
acceptance is a separate gate, as is ADR 0024, which this design builds on.

## Related decisions

- [ADR 0005: Resident Mode and Official Mode](./0005-resident-mode-and-official-mode.md)
- [ADR 0013: The Admin API Is Gated in Middleware, Not Only Per Route](./0013-admin-api-gated-in-middleware.md)
- [ADR 0019: Homeowner Writes Are Official-Mode Gated](./0019-homeowner-writes-official-mode-gate.md)
- [ADR 0022: A Party Roster Separates Identity, Ownership, Representation, Service, and Access](./0022-party-roster-derived-access.md)
- [ADR 0024: Lot Records Are a Per-Lot Private Audience, Not a Fourth Content Tier](./0024-lot-records-per-lot-private-audience.md)
