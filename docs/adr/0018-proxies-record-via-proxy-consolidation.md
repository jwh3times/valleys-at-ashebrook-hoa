# ADR 0018: Proxies Are Their Own Table, Not a Boolean on Every Vote

**Status:** Accepted
**Date:** 2026-08-03

## Context

`member_attendance`, `member_votes`, and `ballots` each carried a `via_proxy` boolean from the day
they were designed. Nothing ever backed it: no table recorded who the proxy holder was, which lot
granted it, or which occasion it covered. PR 4's review flagged this directly — a flag that says
"this was cast by proxy" with no record of _whose_ proxy is not a record, it's a note-to-self. A
board member reading the meeting record or the elections record had no way to answer "who did
lot 42 send in its place," only that someone other than the owner of record had, allegedly, stood
in. That gap was tolerable while proxies were a later phase; it stops being tolerable the moment
this feature ships, because a durable record that cannot name its own proxies is exactly the kind
of half-recorded fact the meeting record, the resolutions book, and the elections record all exist
to avoid elsewhere in this schema.

## Decision

Proxies get their own table. `proxies` records one owner (`grantor_owner_id`) authorising one named
holder to act for one lot (`property_id`) at exactly one occasion — a meeting or an election, never
both, never neither, never open-ended. That "exactly one" rule is enforced by a schema `CHECK`
(`proxies_one_occasion`, `(meeting_id IS NOT NULL) <> (election_id IS NOT NULL)`) rather than left
to application code, so it holds even against a direct write that bypasses the route entirely — the
route's own validation exists only to make the failure readable, not to be the only thing standing
between the data and an incoherent row. A unique index per occasion kind
(`proxies_property_meeting_unq`, `proxies_property_election_unq`) enforces the other half of the
model: one lot gets at most one proxy per occasion, the same "SQLite treats NULLs as distinct so the
two partial-unique indexes don't interfere" trick `resolutions_supersedes_unq` already relies on.

The three `via_proxy` booleans are gone. In their place, `member_attendance.proxy_id`,
`member_votes.proxy_id`, and `ballots.proxy_id` each reference `proxies.id`, and `viaProxy` is now a
**derived** value (`proxy_id IS NOT NULL`) computed at read time rather than a second fact a caller
could set independently of the real one. There is no longer any way for a row to claim "via proxy"
without naming which proxy — the old boolean and the new foreign key could never drift apart from
each other, because only one of them exists. This changes the write contract on every affected
route: `setMemberAttendance`, `setMemberVotes`, and `setBallots` now take `proxyId` instead of
`viaProxy` in their per-row payloads, and the client helpers and admin components were updated to
match (see Task 6).

A proxy is not self-certifying, so the routes that consume `proxy_id` — the three `set*` actions
above — enforce, server-side, everything the schema itself cannot: the referenced proxy must exist;
it must belong to the **same lot** as the attendance/vote/ballot row citing it, because a proxy
authorises acting for _its_ lot, not any lot in the association; and it must scope to the right
occasion, with one deliberate widening — a **meeting-scoped** proxy also covers an **election held
at that meeting**, since the paper proxy a member signed to attend the annual meeting is the same
authorisation covering the board election conducted at it, not a second document nobody asked them
to sign. A proxy scoped to one election or one meeting does not carry over to any other occasion,
even a later one for the same lot. `proxyId` and the represented-by/cast-by owner fields are also
mutually exclusive by server-side guard: recording a proxy for a row clears whichever owner field
that row's shape carries, mirrored client-side by the admin pickers (Task 6) disabling the owner
select the moment a proxy is chosen, so the UI cannot even suggest the illegal combination before
the server would reject it.

`proxyId` on a meeting's attendance/vote rows is admin-only, following the same pattern
`assembleElectionDetail` already established for `ElectionDetail.ballots` in ADR 0017: `viaProxy` is
always derived and returned to every caller, but the real `proxy_id` — which would let a caller work
backward from "this lot's vote was cast by proxy" to "here is exactly who held that proxy" — is
attached only when `assembleMeetingDetail` is called for the admin caller (`includeProxyIds`). This
is the second instance of that admin-caller-flag pattern in the codebase; the two are recorded
together here so a third occurrence recognises the shape rather than re-deriving it.

Deletion is the entire revocation model — there is no `revoked_at` column and none is planned. A
proxy that was never cited anywhere is simply removed: the board mis-recorded it, or the member
changed their mind before the occasion, and there is nothing to retain. A proxy that **was** cited —
by an attendance row, a vote, or a ballot — is part of the record at that point, the same way a
motion cited by a resolution's `adopted_by_motion_id` is part of the record: `DELETE
/api/admin/proxies` pre-checks all three citing tables and returns `409` naming which of them
(`attendance`, `votes`, `ballots`) still reference the proxy, refusing the delete rather than
silently detaching it. That pre-check exists because the foreign key it backs cannot enforce the
refusal itself: `member_attendance.proxy_id`, `member_votes.proxy_id`, and `ballots.proxy_id` were
all added by `ALTER TABLE` against tables that predate this feature, and drizzle-kit silently drops
any `ON DELETE` action on an ALTER-added foreign key column — the same trap already on record for
`properties.vote_weight` and `board_terms.election_id`. Declaring an `onDelete` here would look
correct in the schema file and do nothing in the generated migration, which is worse than declaring
none at all; the column is deliberately actionless, and `proxy-schema.test.ts` pins that the
generated SQL carries no `ON DELETE` clause on these three columns, so a future Drizzle upgrade that
silently starts emitting one — or a hand-edit that assumes it's safe to add one — gets caught by a
failing test instead of a surprise the next time someone deletes a proxy row directly.

## Consequences

Proxies stay board-only end to end in this phase: `proxies.visibility` does not exist as a concept
because there is no public read of the table at all, only the derived `viaProxy` flag surfacing on
the already tier-gated meeting and election reads. A public or homeowner caller can see that a
lot's attendance or vote was recorded by proxy; they cannot see who held it, which lot granted it
beyond the one already named on the row, or any of the other proxies on file for that occasion.
That is a deliberate, narrower disclosure than the admin panel gets, consistent with the same tier
logic every other board-only field in this schema already follows.

The revocation-by-deletion model means a proxy's row disappears once nobody has used it, whether it
was recorded by mistake or simply never needed. This is the right default for a paper-proxy system —
there is no ballot secrecy concern like ADR 0017's, since a proxy grant is itself a public-facing
authorisation on paper, not a secret choice — but it does mean the admin panel is the only place a
board member can double-check "did I already record a proxy for this lot at this meeting" before
adding a second one; the unique index turns a duplicate attempt into a readable `409` rather than a
silent overwrite, but there is no soft-deleted history to consult afterward.

This table is deliberately scoped to what PR 5 needs: a board member typing in a proxy that already
exists on paper, the same "recorded after the fact" posture the elections record itself takes in
ADR 0017. It does not model a homeowner submitting or revoking a proxy grant themselves, and it does
not model a proxy holder's identity as anything more than a name plus an optional link back to
`owners`. PR 7's homeowner-facing proxy grant is expected to build directly on this table rather
than introduce a second one — the same `proxies` row, the same CHECK, the same per-occasion
uniqueness — extending who can write it, not replacing what it records.
