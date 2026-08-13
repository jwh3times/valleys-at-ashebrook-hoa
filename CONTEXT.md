# Valleys at Ashebrook Association

The language used to describe the association's membership, governance, and records.

## Lots and ownership

**Lot**:
A durable association membership and voting unit with a permanent internal identity, linked to Owners through Ownerships. Its address may change without creating a new Lot; retirement occurs only when it permanently ceases to be an association unit, ends its Current Ownerships and derived Lot Authority, and preserves the Lot and all related history.
_Avoid_: Property, home

**Lot Address**:
The Lot's current, unique address used for display and lookup. It is mutable, is not the Lot's identity, and every change is captured by a Roster Change.
_Avoid_: Lot identity, property ID

**Ownerless Lot**:
A non-retired Lot with no Current Ownership. It remains an association unit but is flagged for Board review and supplies no Member Access or Lot Authority until a Current Ownership is recorded.
_Avoid_: Retired Lot, inactive property

**Person**:
A durable human identity, independent of mutable names and Contact Methods. A Person may own Lots directly, represent an Organization, serve on the Board, and have at most one current Person Link.
_Avoid_: Account, user, person record

**Organization**:
A durable non-human ownership identity, such as an LLC, corporation, or trust, that may own Lots and act through Representatives.
_Avoid_: Person, Account

**Owner**:
A Person or Organization that holds or has held an Ownership. Owner identity remains durable after its Ownerships end and is never deactivated.
_Avoid_: Homeowner, resident, account

**Duplicate Owner Consolidation**:
An explicit, audited correction used only when two Owner records represent the same Person or Organization. One Owner survives, the duplicate remains historically traceable to it, and their Ownerships, Contact Methods, Board Terms or Representations, Person Link, and history are preserved; distinct co-owners are never consolidated, and conflicting Person Links must first be resolved by a System Administrator without combining Accounts.
_Avoid_: Owner merge, owner deletion, automatic deduplication

**Contact Method**:
A current email address or phone number belonging to a Person or Organization, with at most one preferred value per channel. Each may have multiple Contact Methods; changes are captured by Roster Changes, and a value shared by multiple identities is not uniquely attributable for automatic verification.
_Avoid_: Lot contact, Account email, Ownership contact

**Account**:
An identity used by one Person to sign in to the site. An Account may have at most one current Person Link, through which its authority follows that Person's Current Ownerships and Representations; Accounts are never shared between Persons.
_Avoid_: Owner, Lot access

**Person Link**:
A time-bounded, verified relationship establishing that an Account represents a Person. Each Account and Person may have at most one current Person Link; the linked Account may end it, while a System Administrator or current Board Member with Board Access may end it with a reason, except that the last System Administrator's link cannot end. Ending removes derived authority and Access Grants, and a replacement requires Person Verification while all links remain auditable.
_Avoid_: Owner Link, Lot link, Account ownership

**Person Verification**:
Proof that an Account represents a specific Person, established through either Automatic Person Verification or Manual Person Verification.
_Avoid_: Ownership proof, Lot verification

**Identity Event**:
An immutable account of an accepted Person Verification or the creation or ending of a Person Link, including the acting Account or automatic cause and when it was recorded. Operational verification attempts, codes, and routine failed matches are not Identity Events.
_Avoid_: Roster Change, Access Event, verification attempt

**Automatic Person Verification**:
A process in which an applicant supplies a Lot Address and Person name without being shown the Lot's Owners, then proves control of a Contact Method uniquely attributable to the one matching individual Current Owner. Success creates a Person Link; organizational ownership, ambiguity, unavailable or shared contacts, and already-linked identities require manual review.
_Avoid_: Owner Verification, Lot verification, property verification

**Manual Person Verification**:
An audited decision creating a Person Link when Automatic Person Verification cannot do so. It may be approved only by a System Administrator or a current Board Member who holds Board Access, and records the approver and reason; authority for an organizational Owner additionally requires a Representation.
_Avoid_: Manual Owner Verification, manual Lot approval, role promotion

**Ownership**:
A non-proportional relationship between an Owner and a Lot whose first Association Day is inclusive and whose optional ending Association Day is exclusive. It records neither ownership percentage nor legal subtype; its first day may be unknown for legacy history, ended Ownerships are preserved, and reacquisition creates a new Ownership.
_Avoid_: Owner record, owner assignment, mapping

**Current Ownership**:
An Ownership whose effective period includes the current Association Day.
_Avoid_: Active owner, active ownership

**Current Owner**:
An Owner with a Current Ownership in the Lot being considered.
_Avoid_: Active owner, homeowner

**Representation**:
A time-bounded, audited authorization for a Person to act for an Organization without becoming an Owner, either organization-wide or limited to explicitly named Lots the Organization owns. An Organization may have multiple current Representatives with equal authority within their scopes; only a System Administrator or current Board Member with Board Access may create, correct, or end one, and Representatives cannot directly appoint others.
_Avoid_: Ownership, Account role, organizational contact

**Lot Authority**:
Equal authority held by every individual Current Owner and every current Representative of an organizational Current Owner to act for a Lot, with no primary-person hierarchy. When an occasion permits one controlling action per Lot, the first valid action controls unless that kind of action remains revocable or correctable under its own rules.
_Avoid_: Primary owner, account ownership

**Association Member**:
An Owner with at least one Current Ownership. An Association Member may be a Person or Organization.
_Avoid_: Homeowner, resident, member user

**Association Day**:
A calendar date interpreted in the association's local time zone, America/New_York.
_Avoid_: UTC date, timestamp

**Effective Day**:
The Association Day on which a roster or Board-service fact became true in the real world. It may precede when the fact is recorded, but an anticipated Ownership is not recorded before it becomes effective.
_Avoid_: Recorded date, creation date

**Recorded At**:
The precise instant when the system learned or recorded a fact, distinct from its Effective Day. A backdated change affects current access when recorded, while preserving its real-world Effective Day and flagging intervening activity for review rather than silently erasing it.
_Avoid_: Effective date, Association Day

**Review Flag**:
A durable indication that a roster, identity, Board-service, or access change may require a human to inspect an affected fact or intervening action. It does not itself invalidate or rewrite that fact or action, and its opening and resolution are preserved through Review Events.
_Avoid_: Automatic reversal, deletion marker

**Review Event**:
An immutable account of opening or resolving a Review Flag, linked to the change that caused the review and recording who or what acted and when.
_Avoid_: Review note, mutable status

**Roster Change**:
An immutable account of a creation, correction, consolidation, retirement, or ending involving a Lot, Person, Organization, Ownership, Representation, or Contact Method. Only a System Administrator or current Board Member with Board Access may accept such a fact, recording its Effective Day, reason, supporting reference, actor, and Recorded At; member-submitted information remains a request until accepted.
_Avoid_: Ownership change, mutable audit row

**Roster Redaction**:
An exceptional, System-Administrator-only removal of a specific Person-name or Contact Method value from authoritative and directly derived roster storage when required by law or binding policy. It preserves an immutable account of what category was redacted, who authorized and performed it, when, and why, without retaining the erased value. Independently authored governance records, correspondence, external systems, and backups follow their own legally governed removal or retention processes.
_Avoid_: Roster correction, record deletion, global string erasure

## Board service and access

**Board Term**:
A period during which an eligible Person serves on the Board and is qualified by one named Lot. Its first day is inclusive, its scheduled ending day is exclusive, and a separate actual ending day preserves an early end. Two Board Terms may never overlap for the same Person or the same Board-Qualifying Lot, so a Person has at most one current Board Term and a Lot qualifies at most one current Board Member; adjacent Terms are valid, which is how a renewal or a successor is recorded.
_Avoid_: Board role, access role

**Cancelled Board Term**:
A Board Term withdrawn before its first day, so no service ever occurred. It is distinct from an early ending, which records service that really happened, and from a Voided Board Term, which records an entry that was never a fact.
_Avoid_: Actual Term End, voided Term

**Voided Board Term**:
A Board Term recorded in error and therefore never true. It is preserved and auditable but is excluded from Board composition, from overlap rules, and from every derivation of authority, and any action recorded during its apparent period is flagged for review rather than erased.
_Avoid_: Deleted Term, Cancelled Board Term

**Scheduled Term End**:
The exclusive Association Day on which a Board Term was expected to end when authorized. It remains preserved if service ends early.
_Avoid_: Actual Term End, overwritten end date

**Actual Term End**:
The exclusive Association Day on which Board service ended earlier than scheduled because of resignation, eligibility loss, or another recorded cause.
_Avoid_: Scheduled Term End, correction date

**Board Office Assignment**:
A time-bounded assignment of one Board Office to a Board Member within a single Board Term. A Board Member may hold at most one office at a time, each office may have at most one current holder, and office changes within a Term preserve continuous Board service. It never carries across into a later Board Term: because the Board appoints its own officers, a renewed Term requires a fresh appointment.
_Avoid_: Board Term, access role, mutable title

**Board Office**:
One of the Board's three named offices: President, Vice President, or Secretary/Treasurer. Secretary and Treasurer are one combined office, as the bylaws provide. Fourth and fifth Board Members serve without a Board Office.
_Avoid_: Access role, Board membership, separate Secretary and Treasurer

**Board Composition Rule**:
The requirement that the Board consist of three to five current Board Members, with its three Board Offices filled by different Board Members. Only current Board Members count toward it; a scheduled Board Term does not. A noncompliant period remains recordable and auditable but is prominently flagged until corrected.
_Avoid_: Access limit, Account count

**Board-Qualifying Lot**:
The one Lot named by a Board Term as the source of the Person's eligibility. For a Representative it must fall within the Representation's scope; a Lot may qualify only one current Board Member, and an eligible substitute may be named only through an audited Board Service Change, never automatically. Requiring one is a deliberate Association practice rather than a bylaws requirement: the bylaws set no eligibility qualification for Board service at all.
_Avoid_: Owned Lot, represented Lot, Board seat

**Board Member**:
An eligible Person serving in a current Board Term.
_Avoid_: Board user, administrator

**Board Service Change**:
An immutable account of a creation, correction, substitution, or ending involving a Board Term or Board Office Assignment, including who made the change and when it was recorded.
_Avoid_: Updated term, mutable audit row

**Access Grant**:
Authorization for an Account with a current Person Link to use a protected part of the site, separate from the Person's association status or service history.
_Avoid_: Board Term, Ownership

**Member Access**:
Access automatically available to an Account linked to a Person who is an individual Association Member or a current Representative of an organizational Association Member. It follows Current Ownership and Representation rather than an Access Grant and ends when the Person loses their final qualifying relationship, without ending the Person Link.
_Avoid_: Homeowner role, member role

**Board Access**:
An Access Grant allowing an Account linked to a Person with a current or scheduled Board Term to use the Board's administration surfaces. It is revoked when that qualifying term ends or is cancelled, never resumes automatically after a later term, and may otherwise be granted or revoked by a System Administrator or by a current Board Member who holds Board Access.
_Avoid_: Board membership, Board Term

**System Administrator**:
An Account holding System Administration Access. A System Administrator need not be an Owner or Board Member.
_Avoid_: Board Member, officer

**System Administration Access**:
An Access Grant containing all Board Access capabilities plus protected technical capabilities. It may be held by an Account that is not linked to an Owner, may be granted or revoked only by a System Administrator, and cannot be revoked from the last System Administrator.
_Avoid_: Board Access, Board membership

**System Administrator Bootstrap**:
A one-time, deployment-authorized grant establishing the first System Administrator for an Account with a current Person Link. It permanently becomes unavailable once any System Administrator exists and cannot create Ownerships, Board Terms, or other association facts.
_Avoid_: Board bootstrap, permanent backdoor

**Access Event**:
An immutable account of a privileged access grant, revocation, or denied attempt, including the acting Account or automatic cause and when the event occurred. Automatic consequences remain linked to the initiating change.
_Avoid_: Access change, mutable audit row
