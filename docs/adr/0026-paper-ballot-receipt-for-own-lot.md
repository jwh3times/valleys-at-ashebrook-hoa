# ADR 0026: A Lot's Own Holders May See Whether Its Paper Ballot Was Recorded

**Status:** Accepted
**Date:** 2026-09-17

## Context

For a `recorded` (paper) election, `ballots` holds one turnout row per lot that returned a ballot
(ADR 0017). The elections design made that per-lot register **board-only**: public and homeowner
readers see aggregate turnout — lots returned and total weight — never which lots, because
publishing per-lot turnout beside the tallies lets anyone derive choices by elimination in a small
race. A homeowner who handed in a paper ballot therefore had no way to confirm the board recorded
it, while a conducted election already gives each lot's holders a selection-free `hasCast`
receipt on `/vote` (ADR 0020).

At its 2026-08-11 meeting the board decided to close that gap (#302): a verified homeowner may
confirm that their own lot is recorded as having returned a paper ballot, and a missed ballot is
corrected by the board against the physical ballot — before certification, or after uncertifying.

## Decision

The per-lot paper turnout register stays board-only **except** that the holders of a lot on the
election's Association Day may see, for that lot alone, whether a ballot is recorded.

- **Audience.** Callers with `member` whose linked Person held Lot Authority over the lot on the
  election date, computed by the same `LOT_SQL` derivation `deriveAccess` uses, bound to that day.
  Not today's holders, not proxy holders, not board admins by virtue of Board Access.
- **Content.** One boolean per such lot: recorded or not. Never a selection, weight, proxy or
  caster provenance, recording time, or anything about another lot.
- **Scope in the query.** Lot set, election status (`closed`/`certified`), `source = 'recorded'`,
  and tier are all constrained inside one SQL statement with no caller-supplied lot or election
  parameter.
- **Correction.** Amendment uses the board's existing `setBallots` path while `closed`; a certified
  result must be uncertified first. `setBallots` preserves the identity of unchanged rows so an
  amendment does not disturb review-flag references or recording instants.

The design, including placement on `/elections`, copy, tests, and delivery slices, is
[`docs/specs/2026-09-17-paper-ballot-receipt-design.md`](../specs/2026-09-17-paper-ballot-receipt-design.md).

## Consequences

- ADR 0017's secrecy property is unchanged: no choice is recorded for a paper election, so there
  is still nothing to reveal about how any lot voted.
- The arithmetic-disclosure residual ADR 0017 names now reaches the lot's **co-holders**: in a
  one-ballot or unanimous race, a co-owner who did not hand in the lot's ballot learns the lot
  voted, and can infer how. This is the same disclosure `hasCast` already makes for conducted
  elections, and it never reaches anyone outside the lot's holders on the election date.
- The receipt is ungated by `officialMode` and `liveVotingEnabled`: it is a scoped read of a record
  `/elections` already publishes in resident mode, not association business conducted through the
  site (ADR 0019).
- Uncertifying to correct a certified result ends the Board Access grants its terms qualified;
  those must be re-granted by hand after recertification.

## Related decisions

- [ADR 0017: Elections Are Secret by Construction, and What That Does and Does Not Mean](./0017-elections-secret-by-construction.md)
- [ADR 0019: Homeowner Writes Are Official-Mode Gated](./0019-homeowner-writes-official-mode-gate.md)
- [ADR 0020: Digital Ballots Are Retained Without an Explicit Turnout-to-Choice Link](./0020-digital-ballot-box.md)
- [ADR 0022: A Party Roster Separates Identity, Ownership, Representation, Service, and Access](./0022-party-roster-derived-access.md)
