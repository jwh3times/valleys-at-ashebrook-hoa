# Migrations

How D1 schema changes are authored, applied, and verified — and the four ways this project has
been bitten. Read this before writing a migration or running one against production.

Migrations are applied locally with `npm run db:migrate:local` via Wrangler, which tracks applied
files in D1 independently of Drizzle's `meta/` snapshots.

## The rules that bite

**The directory is what runs.** `wrangler d1 migrations apply` reads every `.sql` file under
`migrations_dir` in filename order; it never opens `meta/_journal.json`. Measured 2026-08-21: a
`.sql` file with no journal entry is listed as pending and applied all the same. The risk is
therefore the inverse of what you would assume — a forgotten journal entry is harmless, while a
stray or mis-numbered `.sql` file is a production migration nobody wrote on purpose.
`npm run lint:migrations` (`scripts/check-migration-files.ts`, enforced by CI) is the gate:
well-formed names, unique and contiguous indices, and a journal that does not disagree with the
directory.

**Hand-author structural migrations; `npm run db:generate` is not part of the workflow.** The
Drizzle snapshot chain is deliberately abandoned (#257). Snapshots are missing for `0019`-`0021`
and `0028`-`0029`, so the newest one (`0027`) still describes `candidates.board_person_id`,
`proxies.grantor_owner_id`/`holder_owner_id`, `member_attendance.represented_by_owner_id`, and
both `cast_by_owner_id` columns — every one renamed by #248. Running the generator diffs
`schema.ts` against that stale world and proposes replaying both #248 table rebuilds on top of
whatever you actually changed. `lint:migrations` guards the directory and `verify:invariants` is
the real correctness gate against the live schema; the snapshots under `meta/` are retained as
history, not maintained. If a future change needs the generator, repairing the chain is its first
step, and #257 records what that costs.

**Committed migrations do NOT reach production on their own.** Deploys never apply D1 migrations.
The path is the operator running `npm run db:migrate:remote`, which applies any unapplied files
and is safe to re-run (Wrangler tracks applied files in D1 and skips them). This doctrine once
said the opposite, inferred from `0016`-`0022` landing at one timestamp shortly after their merge;
that inference was falsified on 2026-08-17, when deploys had succeeded daily while migrations
`0023`-`0027` sat unapplied under v0.12.0 code.

**`db:migrate:remote` reads the LOCAL migrations directory, so a stale checkout reports success.**
The first `0029` attempt ran from a checkout that predated the merge. Having no `0029` file on
disk, wrangler compared what it had against `d1_migrations`, found nothing unapplied, and printed
`✅ No migrations to apply!` — true of that disk, and indistinguishable from the message a
correctly-applied database produces. Workers Builds had already deployed the merged code, so
production served the new application against the old schema, with the member attendance, member
vote, ballot, and proxy surfaces failing, while the operator's terminal said everything was fine.
The only tell was npm's own banner printing `@0.15.0` when the merge had minted `0.16.0`. A
`git pull` and a re-run applied it (26 commands: the file's 25 statements plus wrangler's
`d1_migrations` insert), and `verify:invariants --remote` was 17/17 including
`PRAGMA foreign_key_check`. `scripts/check-migrations-current.ts` now refuses the apply from a
checkout behind `origin/main`, naming the migrations it lacks, so the silent no-op becomes a loud
refusal; `MIGRATE_ALLOW_BEHIND=1` is the documented override.

## Deployment ordering

The default rule is **safe in either order**: merged code can run ahead of the production schema
for days, so a schema change and the code that depends on it must both work against either shape.
That is the whole reason ADR 0022 phase 1 is behaviorally inert. Schema parity is also a
**standing pre-freeze check** — before any write freeze, backfill, or other schema-dependent
operation, `npx wrangler d1 migrations list DATABASE --remote` must list nothing unapplied.

**Migrations `0028` and `0029` break that rule, and are the first two in this project to do so.**
`0028` renames `candidates.board_person_id` to `candidates.person_id` and repoints
`board_attendance.person_id`/`board_votes.person_id`/`motions.mover_person_id`/
`motions.second_person_id` off `board_people` onto `people(party_id)`, while the merged
application code (`GET /api/admin/meetings?roster=people`, `/api/admin/candidates`,
`assembleMeetingDetail` in `src/server/content/reads.ts`) reads and writes only the new column and
table. That code deployed ahead of the migration — Workers Builds deploys on merge — and the admin
meeting-record people picker and the candidate-link write path failed against the still-legacy
schema until the operator ran `npm run db:migrate:remote` minutes later, on 2026-08-21. `0029` is
the second of the kind and was written knowing it, renaming four more columns the merged code
reads and writes.

**The standing rule this leaves behind:** a migration that renames or repoints a column the
merged code depends on is applied _before or together with_ that change's deploy — treat the
merge and `db:migrate:remote` as ONE operator step, ideally under the write freeze — never on the
otherwise-safe any-time-before-the-next-freeze schedule. Phase 4's `properties` → `lots` rename is
the next of this kind.

## The ledger

One line per migration. The files themselves are the detail; this table exists so you can find
which migration introduced a shape without reading all thirty.

| #             | What it did                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000` `0001` | Initial schema.                                                                                                                                            |
| `0002`        | Split homes and people into `properties` and `owners`.                                                                                                     |
| `0003`        | Uniqueness (`properties.address_normalized`, `user_property_links (user_id, property_id)`) and hot-path indexes.                                           |
| `0004`        | `documents.content_hash` + `documents_content_hash_idx` for duplicate detection.                                                                           |
| `0005`        | Reconciled foreign keys and enums on the roster/verification tables.                                                                                       |
| `0006`        | `documents.keep_verified_at` / `keep_verified_by`.                                                                                                         |
| `0007`        | `documents.rag_status`.                                                                                                                                    |
| `0008`        | `reports` table + `reports_created_at_idx`.                                                                                                                |
| `0009`        | `board_people`, `board_terms` + indexes on `person_id` and `term_end`.                                                                                     |
| `0010`        | Meeting record: `meetings`, `board_attendance`, `motions`, `board_votes` + status/body/sequence indexes.                                                   |
| `0011`        | `properties.vote_weight`; `member_attendance`, `member_votes`; `motions.mover_owner_id`/`second_owner_id`.                                                 |
| `0012`        | `resolutions` + `resolutions_number_unq`, `resolutions_supersedes_unq`, `resolutions_status_idx`.                                                          |
| `0013`        | `elections`, `candidates`, `ballots` + indexes; nullable `board_terms.election_id`.                                                                        |
| `0014`        | `proxies` + per-occasion unique indexes and the `proxies_one_occasion` CHECK.                                                                              |
| `0015`        | Dropped `via_proxy` from three tables; added each one's `proxy_id`.                                                                                        |
| `0016`        | `ballot_choices`, `election_eligibility`, `motion_eligibility`, `motions.voting_state`.                                                                    |
| `0017`        | `motions.voting_revision` — the live-motion compare-and-swap token.                                                                                        |
| `0018`        | `meetings.approved_by_motion_id` FK (delete-set-null), clearing dangling values.                                                                           |
| `0019`        | ADR 0022 party-roster core: 13 tables + the `system_admin_bootstrap` singleton, all `IF NOT EXISTS`.                                                       |
| `0020`        | Immutable audit ledger: `audit_events`, seven typed detail tables, subject/delta tables, `review_flags`, `redaction_tasks`.                                |
| `0021`        | `cutover_settings` (the `cutover_mode`/`write_freeze` singletons) and `cutover_shadow_mismatches`.                                                         |
| `0022`        | `properties.retired_day`/`retired_at`. **The one non-idempotent file** — SQLite has no `ADD COLUMN IF NOT EXISTS`, so it is isolated to its own migration. |
| `0023`        | Eight ADR 0022 views, every statement `CREATE VIEW IF NOT EXISTS`, so the file is safe to re-run.                                                          |

### `0024`-`0029`: the table-rebuild migrations

These six carry techniques you will need again, so they are described rather than tabulated.

`0024` adds `correction_requests` and **rebuilds** `board_service_changes` so its reason-code
CHECK accepts `legacy_migration_baseline` — the code the backfill's board-term baseline emits, a
latent flip-blocker until this migration. The rebuild drops the two views that reference the table
and `0025` recreates them, because SQLite's `ALTER ... RENAME` reparses every view. It uses D1's
`PRAGMA defer_foreign_keys`, **not** the unsupported `PRAGMA foreign_keys`.

`0025` also redefines `board_eligibility_violations_v` twice over: concluded terms are excluded
(eligibility is owed only while a term is current or scheduled — without this, every
mutation-boundary termination lights the view up), and a Representation's future end day now
reads as authority until it arrives, matching #202.

`0026` rebuilds three more tables inside `PRAGMA defer_foreign_keys`. `contact_methods` gains
`party_kind` plus a composite FK to `parties(id, kind)` and a `UNIQUE (id, party_kind)` index —
the target that lets `person_verifications` structurally require a _Person's_ contact rather than
an Organization's (#202). `person_verifications` gains the paired `contact_method_party_kind`
column replacing its old single-column contact FK, plus a `person_verifications_bootstrap_shape`
CHECK closing the shape gap the automatic/manual CHECKs left open. `identity_events` — provably
empty, having never had a writer — is DROP+CREATEd to add the opaque `evidence_request_id` locator
and an `identity_events_evidence_exactly_one` CHECK mirroring `roster_changes`, dropping the
`election` evidence kind (an election proves nothing about who an account is) while leaving
`reason_code` deliberately unchecked — the same discipline-over-CHECK lesson `0024` recorded. The
file also adds `verification_codes` and `verification_review_requests`, and drops-then-recreates
the two views referencing `identity_events` verbatim.

`0027` gives the never-written `review_flags` table its first writer, as a plain DROP+CREATE (the
`0026` precedent). It adds `impacted_motion_id` (FK restrict to `motions` — a
`vote_reset_on_transfer` flag names the motion whose vote was reset, since the reset DELETES the
`member_votes` row the old shape would have pointed at), widens the at-most-one impact CHECK, and
converts the four legacy-record impacted FKs from RESTRICT to `ON DELETE SET NULL`: proxy deletion
is the entire revocation model and the `setMemberAttendance`/`setMemberVotes`/`setBallots` actions
are full-replacement corrections, so a flag must survive the referenced record's deletion with its
source event intact rather than freezing that record in place.

`0028` and `0029` are #248, the ADR 0022 phase 4 precondition, and they are the two migrations
that break the safe-in-either-order rule — see [Deployment ordering](#deployment-ordering) above.
`0028` repoints five FK columns off the legacy `board_people` onto `people(party_id)` and drops
the parallel `motions.mover_owner_id`/`second_owner_id` pair outright, since nothing ever wrote
it. `0029` does the same for the `owners` half, rebuilding `member_attendance`, `member_votes`,
`ballots`, and `proxies`.

Three durable techniques come out of that pair:

- **Rebuild order follows the FK graph.** `motions` is rebuilt last in `0028` because six FKs
  point into it; `proxies` is rebuilt last in `0029` because the other three cite it.
- **`__new`-copy-and-rename, not DROP+CREATE**, whenever a table is only _provably empty in
  production_ rather than everywhere (the `0024`/`0026` precedent; `0027` could use DROP+CREATE
  because `review_flags` had never had a writer at all).
- **Never invent an identity.** A legacy value is carried over only when it already resolves to a
  Person: nullable columns become `NULL`, and a `NOT NULL` column (`board_attendance.person_id`,
  `board_votes.person_id`, `proxies.grantor_person_id`) drops the row rather than fabricate one.

`0028` also moves `ballot_choices.candidate_id` from `ON DELETE RESTRICT` to `NO ACTION`, for an
unrelated reason worth remembering: **RESTRICT is checked immediately and NO ACTION at
end-of-statement**, and only the latter makes an election delete — which cascades into
`candidates` and `ballot_choices` alike — independent of which cascade SQLite happens to run
first. A bare candidate delete is refused identically either way. `0029` applies the same
reasoning deliberately when it recreates the three `proxy_id` FKs as actionless.

### Applied to production

| Migrations     | Applied    | Note                                                                    |
| -------------- | ---------- | ----------------------------------------------------------------------- |
| through `0015` | 2026-08-05 |                                                                         |
| `0016`-`0022`  | 2026-08-14 | Verified against the `d1_migrations` ledger, not assumed.               |
| `0023`-`0027`  | 2026-08-17 | After sitting unapplied for days under deployed v0.12.0 code.           |
| `0028`         | 2026-08-21 | Immediately after its change merged — the ordering hazard above.        |
| `0029`         | 2026-08-21 | On the **second** attempt; the first was the stale-checkout trap above. |

## The drizzle-kit ALTER trap

drizzle-kit silently drops any `ON DELETE` action on an FK column added by `ALTER TABLE`. On
record for `properties.vote_weight`, `board_terms.election_id`, and the three `proxy_id` columns;
`proxy-schema.test.ts` pins that the generated `0014` SQL carries none. Since `0029` rebuilt those
three tables the actionless FKs are a _decision_ rather than an accident — see the `proxies` entry
in [`data-model.md`](./data-model.md).
