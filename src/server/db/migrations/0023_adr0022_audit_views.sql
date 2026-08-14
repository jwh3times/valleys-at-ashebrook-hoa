-- ADR 0022 phase 2: audit read models and integrity views.
--
-- Server-side query shapes, NOT authorization boundaries. There is no public or
-- homeowner audit endpoint, and a view never decides access — the capability
-- gate on the calling route does.
--
-- Live authorization is never derived from these. It reads current domain rows,
-- and it must never grant because a reconstruction succeeded or fail because one
-- did not.
--
-- Every statement is IF NOT EXISTS so a half-applied file can be run forward.
-- Views hold no data, so this file is safe to re-run at any time.

-- Envelope plus its typed detail, with the latest applicable metadata
-- correction overlaid. Raw mode is the underlying tables; this is corrected
-- mode. A correction may only address allow-listed non-personal metadata —
-- Effective Day and basis, reason code, supporting reference — and can never
-- alter the original's id, family, Recorded At, actor, correlation, or cause.
CREATE VIEW IF NOT EXISTS audit_event_effective_v AS
SELECT
  e.ledger_sequence,
  e.id,
  e.family,
  e.event_kind,
  e.correlation_id,
  e.correlation_sequence,
  e.causing_event_id,
  e.actor_kind,
  e.actor_account_id,
  e.automatic_cause,
  e.operation_key,
  e.recorded_at,
  COALESCE(rc.effective_day, bsc.effective_day) AS effective_day,
  COALESCE(rc.effective_day_basis, bsc.effective_day_basis) AS effective_day_basis,
  COALESCE(rc.reason_code, bsc.reason_code, ie.reason_code, ae.reason_code, rr.reason_code) AS reason_code,
  COALESCE(rc.evidence_kind, bsc.evidence_kind, ie.evidence_kind) AS evidence_kind,
  -- Latest correction wins; the full chain stays queryable on the table.
  (SELECT arc.event_id FROM audit_record_corrections arc
     WHERE arc.corrected_event_id = e.id
     ORDER BY arc.correction_sequence DESC LIMIT 1) AS latest_correction_event_id,
  (SELECT COUNT(*) FROM audit_record_corrections arc
     WHERE arc.corrected_event_id = e.id) AS correction_count
FROM audit_events e
LEFT JOIN roster_changes rc ON rc.event_id = e.id
LEFT JOIN board_service_changes bsc ON bsc.event_id = e.id
LEFT JOIN identity_events ie ON ie.event_id = e.id
LEFT JOIN access_events ae ON ae.event_id = e.id
LEFT JOIN roster_redactions rr ON rr.event_id = e.id;
--> statement-breakpoint

-- Typed subject union as (event, kind, durable id, role), so one query answers
-- "what did this event touch" across families.
--
-- D1 CAPS COMPOUND SELECTS AT FIVE TERMS. The obvious shape here — one branch
-- per typed subject column — needs nine and fails to create with
-- "too many terms in compound SELECT". CASE plus COALESCE over each table
-- avoids the union entirely, which is legal precisely because each subject
-- table's CHECK already guarantees exactly one non-null typed column per row.
-- The constraint that forced this also made it cheaper: one scan per table
-- instead of six.
CREATE VIEW IF NOT EXISTS audit_event_subjects_v AS
SELECT
  event_id,
  CASE
    WHEN lot_id IS NOT NULL THEN 'lot'
    WHEN party_id IS NOT NULL THEN 'party'
    WHEN contact_method_id IS NOT NULL THEN 'contact_method'
    WHEN ownership_id IS NOT NULL THEN 'ownership'
    WHEN representation_id IS NOT NULL THEN 'representation'
    WHEN person_link_id IS NOT NULL THEN 'person_link'
  END AS subject_kind,
  COALESCE(
    lot_id, party_id, contact_method_id, ownership_id, representation_id,
    person_link_id
  ) AS subject_id,
  role
FROM roster_change_subjects
UNION ALL
SELECT
  event_id,
  CASE
    WHEN board_term_id IS NOT NULL THEN 'board_term'
    WHEN office_assignment_id IS NOT NULL THEN 'office_assignment'
    WHEN lot_id IS NOT NULL THEN 'lot'
  END AS subject_kind,
  COALESCE(board_term_id, office_assignment_id, lot_id) AS subject_id,
  role
FROM board_service_change_subjects;
--> statement-breakpoint

-- One durable subject's events in global ledger order. Pagination and replay
-- use ledger_sequence; displays use recorded_at.
CREATE VIEW IF NOT EXISTS audit_entity_history_v AS
SELECT
  s.subject_kind,
  s.subject_id,
  s.role,
  e.ledger_sequence,
  e.id AS event_id,
  e.family,
  e.event_kind,
  e.correlation_id,
  e.recorded_at
FROM audit_event_subjects_v s
JOIN audit_events e ON e.id = s.event_id;
--> statement-breakpoint

-- One accepted command as a causal tree: local ordering within the correlation,
-- global ordering across the ledger.
CREATE VIEW IF NOT EXISTS audit_operation_timeline_v AS
SELECT
  e.correlation_id,
  e.correlation_sequence,
  e.ledger_sequence,
  e.id AS event_id,
  e.family,
  e.event_kind,
  e.causing_event_id,
  c.event_kind AS causing_event_kind,
  e.actor_kind,
  e.actor_account_id,
  e.automatic_cause,
  e.recorded_at
FROM audit_events e
LEFT JOIN audit_events c ON c.id = e.causing_event_id;
--> statement-breakpoint

-- Open flags with their cause and typed impact. A flag never rewrites or
-- invalidates the action it references; this is a work queue, not a verdict.
CREATE VIEW IF NOT EXISTS audit_review_queue_v AS
SELECT
  f.id AS flag_id,
  f.category,
  f.status,
  f.opened_at,
  f.source_event_id,
  e.event_kind AS source_event_kind,
  e.correlation_id,
  e.recorded_at AS source_recorded_at,
  CASE
    WHEN f.impacted_proxy_id IS NOT NULL THEN 'proxy'
    WHEN f.impacted_member_attendance_id IS NOT NULL THEN 'member_attendance'
    WHEN f.impacted_member_vote_id IS NOT NULL THEN 'member_vote'
    WHEN f.impacted_ballot_id IS NOT NULL THEN 'ballot'
    WHEN f.impacted_board_term_id IS NOT NULL THEN 'board_term'
    WHEN f.impacted_access_grant_id IS NOT NULL THEN 'access_grant'
    WHEN f.impacted_event_id IS NOT NULL THEN 'audit_event'
  END AS impacted_kind,
  COALESCE(
    f.impacted_proxy_id, f.impacted_member_attendance_id, f.impacted_member_vote_id,
    f.impacted_ballot_id, f.impacted_board_term_id, f.impacted_access_grant_id,
    f.impacted_event_id
  ) AS impacted_id
FROM review_flags f
JOIN audit_events e ON e.id = f.source_event_id
WHERE f.status = 'open';
--> statement-breakpoint

-- Redaction evidence and cleanup state, PHYSICALLY SEPARATE from the general
-- feed. System-Administrator-only, and it never contains the erased value —
-- only the durable target, field category, authority, and task status.
CREATE VIEW IF NOT EXISTS audit_redaction_compliance_v AS
SELECT
  e.id AS event_id,
  e.recorded_at,
  e.actor_account_id AS performed_by_account_id,
  r.target_person_id,
  r.target_contact_method_id,
  r.field_category,
  r.authorized_by_account_id,
  r.authority_kind,
  r.authority_reference,
  r.reason_code,
  (SELECT COUNT(*) FROM redaction_tasks t WHERE t.redaction_event_id = e.id) AS task_count,
  (SELECT COUNT(*) FROM redaction_tasks t WHERE t.redaction_event_id = e.id AND t.status = 'pending') AS tasks_pending,
  (SELECT COUNT(*) FROM redaction_tasks t WHERE t.redaction_event_id = e.id AND t.status = 'failed') AS tasks_failed
FROM audit_events e
JOIN roster_redactions r ON r.event_id = e.id;
--> statement-breakpoint

-- Structural violations of the ledger's own rules. A non-empty result means a
-- writer bypassed its atomic batch, and audit reads return a controlled 503
-- rather than partial history when implicated.
--
-- Deliberately NOT a source of authorization decisions: live access is based on
-- current facts and never grants because reconstruction failed.
--
-- THIS VIEW IS AT D1'S FIVE-TERM COMPOUND SELECT CEILING. Adding a sixth check
-- here will not fail a test subtly — the view will refuse to create and the
-- migration will fail outright with "too many terms in compound SELECT". Add
-- the sixth as a second view, or fold it into an existing branch.
CREATE VIEW IF NOT EXISTS audit_integrity_violations_v AS
-- Missing or duplicated typed detail.
SELECT e.id AS event_id, 'detail_cardinality' AS violation FROM audit_events e
WHERE ((SELECT COUNT(*) FROM roster_changes d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM board_service_changes d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM identity_events d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM access_events d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM roster_redactions d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM review_events d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM audit_record_corrections d WHERE d.event_id = e.id)) <> 1
UNION ALL
-- Causation crossing correlations, or pointing forward in local order.
SELECT e.id, 'causal_order' FROM audit_events e
JOIN audit_events c ON e.causing_event_id = c.id
WHERE c.correlation_id <> e.correlation_id
   OR c.correlation_sequence >= e.correlation_sequence
UNION ALL
-- A correction that does not point at a real event.
SELECT a.event_id, 'orphan_correction' FROM audit_record_corrections a
WHERE NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.id = a.corrected_event_id)
UNION ALL
-- A redaction without its evidence or without cleanup work.
SELECT e.id, 'redaction_incomplete' FROM audit_events e
WHERE e.family = 'roster_redaction'
  AND (NOT EXISTS (SELECT 1 FROM roster_redactions r WHERE r.event_id = e.id)
    OR NOT EXISTS (SELECT 1 FROM redaction_tasks t WHERE t.redaction_event_id = e.id))
UNION ALL
-- A flag that no Review Event ever opened.
SELECT f.id, 'flag_without_opening_event' FROM review_flags f
WHERE NOT EXISTS (SELECT 1 FROM review_events v WHERE v.review_flag_id = f.id);
--> statement-breakpoint

-- Board Terms whose qualifying basis has disappeared.
--
-- Derived authorization deliberately does NOT join Ownership on the hot path:
-- the mutation boundary substitutes or terminates atomically when an Ownership
-- or Representation ends, and re-checking per request would double the
-- authorization query to defend against a bug that boundary already prevents.
-- This view is how that decision stays honest. A row here is an anomaly to
-- investigate, never an input to a permission decision.
--
-- A NULL qualifying_lot_id is legal only for accepted legacy terms that have
-- already ended, so a CURRENT term with no Lot is itself a violation.
CREATE VIEW IF NOT EXISTS board_eligibility_violations_v AS
SELECT
  t.id AS board_term_id,
  t.person_id,
  t.qualifying_lot_id,
  CASE
    WHEN t.qualifying_lot_id IS NULL THEN 'current_term_without_qualifying_lot'
    ELSE 'qualifying_basis_missing'
  END AS violation
FROM board_service_terms t
WHERE t.voided_at IS NULL
  AND t.cancelled_at IS NULL
  AND (
    t.qualifying_lot_id IS NULL
    OR NOT EXISTS (
      -- Direct ownership of the qualifying Lot.
      SELECT 1 FROM ownerships o
      WHERE o.owner_party_id = t.person_id
        AND o.lot_id = t.qualifying_lot_id
        AND o.voided_at IS NULL
        AND o.end_day IS NULL
      UNION ALL
      -- Or representation of an Organization that owns it: organization-wide
      -- scope resolves by join, Lot-scoped intersects its named Lots.
      SELECT 1 FROM representations r
      JOIN ownerships o2 ON o2.owner_party_id = r.organization_party_id
        AND o2.lot_id = t.qualifying_lot_id
        AND o2.voided_at IS NULL
        AND o2.end_day IS NULL
      WHERE r.representative_person_id = t.person_id
        AND r.voided_at IS NULL
        AND r.end_day IS NULL
        AND (
          r.scope_kind = 'organization'
          OR EXISTS (
            SELECT 1 FROM representation_lots rl
            WHERE rl.representation_id = r.id
              AND rl.lot_id = t.qualifying_lot_id
              AND rl.voided_at IS NULL
          )
        )
    )
  );
