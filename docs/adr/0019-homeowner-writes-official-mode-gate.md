# ADR 0019: Homeowner Writes Are Official-Mode Gated

**Status:** Accepted
**Date:** 2026-08-04

## Context

PRs 1–6 record association events that happened elsewhere. PR 7b is the first surface on which a
homeowner performs association business _through_ this site: granting or revoking a proxy for a
lot they control. The site remains resident-run rather than the official HOA by default (ADR 0005),
so conducting business — unlike recording it after the fact — needs an explicit, board-controlled
authorization. `officialMode` supplies that authorization and fails closed to off.

This write surface also joins possession-based verification to a legal-ish act that needs both a
lot and an occasion. The system must show enough information to choose the occasion and proxy
holder without turning member access into a browsable roster or weakening the approval gate on
meeting and election records.

## Decision

Every homeowner-write page and API route applies the same gate in the same order. If
`officialMode` is off, it returns **404**, never 403: an unofficial site does not advertise that
the homeowner business surface exists, following ADR 0014's never-confirm posture for draft
meetings. If the mode is on, an anonymous caller receives 401; an authenticated caller below the
homeowner role receives 403; only then do `requirePropertyAccess` and the active-owner checks
enforce the per-lot scope. `requireMemberApi` is the per-route enforcement layer, while
middleware is the redundant `/api/member/*` backstop. Both layers are pinned by tests, including
`member-routes-all-gated.test.ts`, following ADR 0013's deliberately redundant pattern. The
Workers test pool does run direct middleware tests, so the backstop is tested as well as the
handler guard.

Verification proves control of a lot by delivering an OTP to a roster contact; identity _within_
that lot is self-asserted when the grantor chooses an active owner. That is the same practical
trust model as a paper proxy, where nobody handwriting-checks a signature at entry. It also avoids
a `user_property_links.owner_id` migration with a backfill hole: existing links and `board_manual`
verifications do not name an owner. A later upgrade to a proven owner identity can add that fact
without invalidating these grants.

`fetchUpcomingOccasionsFor` deliberately narrows ADR 0014 for an occasion picker and its write
path. It exposes the scheduled existence — title, date, and, for elections, seats — of an upcoming
member-body meeting or non-terminal election at the occasion's own visibility tier regardless of
status. This is a meeting notice, not the record: minutes, motions, attendance, tallies, and all
other occasion content remain status-gated exactly as ADR 0014 and the election record require.
Member `POST` accepts the same homeowner-visible draft meetings and non-terminal elections that
the picker exposes as valid grant occasions. This is intentional: a homeowner cannot grant for a
secret occasion, but may grant ahead of an occasion that the board has explicitly published by
raising its otherwise-default-`board` visibility.

The grant's holder picker resolves one typed street address to the active owner names for that lot,
never contact data. It is available only to a verified homeowner behind the official-mode and
member gates, at the same practical granularity as county deed records, so an online grant can
always save `holder_owner_id` and the holder can act at `/vote` in PR 7c. The broader roster remains
board-only. A verified homeowner can nevertheless iterate typed addresses and harvest active owner
names. That names-only disclosure is attributable to the caller and is accepted for PR 7b; a later
mitigation may reuse `src/server/verification/rate-limit.ts` if experience makes one necessary.

An own-lot exception is deliberate. A homeowner may see the title and date of the occasion tied to
a proxy for their own lot even when that occasion is not otherwise visible at their tier. This is
identity-and-occasion metadata needed to understand or revoke the caller's own grant, not meeting
or election content; it does not disclose minutes, motions, attendance, tallies, or any other
record detail.

## Consequences

Revocation remains deletion under ADR 0018, including its used-proxy 409 when attendance, votes,
or ballots cite the proxy. The granting homeowner can now reach that refusal for a proxy on one of
their own lots. Granted and held proxy reads are likewise scoped to the caller's lots and never
widen into a member-visible proxy register.

PR 7c reuses `requireMemberApi` and this ADR's gate order verbatim for `/api/vote`. It may build on
the deliberate occasion and holder metadata described here, but it must preserve the distinction
between a published upcoming occasion and the status-gated record of what happened there.
