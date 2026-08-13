# ADR 0022: A Party Roster Separates Identity, Ownership, Representation, Service, and Access

**Status:** Accepted
**Date:** 2026-08-12

## Context

The original roster stores one owner row per property, verifies an account for a property rather
than a person, keeps board people separate from owners, and uses one account role for member and
board authorization. That shape cannot represent one person owning several lots, organizational
owners and their representatives, a durable ownership history, or a technical administrator who
is not a member. It also conflates association facts such as ownership and board service with site
permissions that may need to begin early, end immediately, or be suspended independently.

## Decision

Use a durable party roster whose core identities are **Lot**, **Person**, and **Organization**. A
Person or Organization becomes an Owner through a time-bounded **Ownership** rather than by being
nested under one Lot. A Person may act for an organizational Owner through a time-bounded,
optionally Lot-scoped **Representation**. Multiple direct Owners and Representatives have equal Lot
Authority; the first valid action controls where an occasion permits one action per Lot.

An Account represents at most one Person through a time-bounded **Person Link**, and a Person has at
most one current Person Link. Automatic and manual Person Verification establish that identity;
they do not establish ownership. Member Access and Lot Authority are derived from the linked
Person's Current Ownerships and Representations. Ending a Person Link removes derived authority and
privileged grants without deleting the Person or their history.

Board service is a fact about an eligible Person, not an Account permission. A **Board Term** names
one Board-Qualifying Lot, and no Person or Lot may support more than one current Board Term. A Board
has three to five members; President, Secretary, and Treasurer are separate, time-bounded Board
Office Assignments held by different members, while fourth and fifth members have no office.
Temporary composition violations remain recordable but are flagged. **Board Access** is a separate
grant available only for a current or scheduled Board Term. **System Administration Access**
contains Board capabilities plus technical capabilities, may be held by a non-owner Person, may be
managed only by another System Administrator, and may never be removed from the last System
Administrator. A one-time deployment bootstrap establishes only the first identified System
Administrator.

Lots, parties, Contact Methods, Ownerships, Representations, Board Terms, office assignments, Person
Links, and privileged access retain immutable change history. Domain facts carry an Association
Day on which they became effective, while audit records separately retain the precise instant at
which the system recorded them. Backdated facts are allowed, anticipated Ownerships are not, and
intervening actions are flagged rather than silently erased. A narrowly authorized Roster
Redaction may remove personal values required by law or binding policy while preserving evidence
of the redaction.

## Consequences

The schema must replace property-nested owner rows with separate parties and relationships, unify
the board's human identity with Person, derive member authorization instead of storing a homeowner
role, and model Board and System Administration Access independently. Existing property links do
not prove which co-owner controlled an Account and therefore must not be silently converted into
Person Links; migration requires new automatic verification or an audited manual decision.

## Correction (2026-08-13)

The Decision above names the Board's offices as President, Secretary, and Treasurer. That is wrong
against the Association's own bylaws, which provide for a president, a vice-president, and a
combined secretary/treasurer, appointed by the Board from among its members. The office names are
corrected in `CONTEXT.md`; the rest of the Decision stands unchanged, including that offices are
separate, time-bounded Board Office Assignments held by different members.

The bylaws also set no eligibility qualification for Board service. Requiring a Board-Qualifying Lot
is therefore an Association practice this project chooses to enforce, not a bylaws requirement, and
should not be cited as one.

This ADR supersedes the identity and authorization shapes in ADRs 0001, 0003, 0006, 0012, and 0019.
Their remaining decisions still stand: possession-based codes remain an acceptable automatic
verification mechanism, Better Auth remains the Account provider, board records remain structured,
official mode remains the gate for member business, and the existing secret-ballot model remains
unchanged.
