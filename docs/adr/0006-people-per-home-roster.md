# ADR 0006: People-per-Home Roster

**Status:** Accepted
**Date:** 2026-07-08

**Phase 4 implementation note (#212):** The original owner/link/verification schema is removed. Lots live in `lots`; authority comes from Person Links and the party roster. See [ADR 0022](./0022-party-roster-derived-access.md).

## Context

The owner roster can contain multiple owners for one property. A flat "one row per
home" owner model loses individual contact details and makes ownership transfers
awkward.

## Decision

Model homes and people separately:

- `properties` stores the home and normalized address used for matching.
- `owners` stores each person and their optional phone/email contacts.
- Verification links a user to a property, not to one owner person.

When verification is requested, send the one-time code to every distinct active
contact for the selected channel on that property. Ownership transfers are handled
by deactivating old owner records and adding new owner records while preserving
the property.

## Consequences

- Co-owners can each receive verification codes.
- One user can still be linked to multiple properties.
- Tenant/renter modeling remains a separate policy and product decision.
- Future roster import and transfer tooling should preserve the home/person split.
