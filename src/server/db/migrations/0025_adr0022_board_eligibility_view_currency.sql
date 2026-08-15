-- ADR 0022 phase 3b (#218): recreate the views migration 0024 had to drop, and
-- scope the board-eligibility integrity view to terms still running or
-- scheduled.
--
-- 0024 rebuilds `board_service_changes` (its reason-code CHECK gains
-- `legacy_migration_baseline`, which the backfill's board-term baseline emits;
-- without it the authoritative run would fail that CHECK). SQLite's
-- ALTER TABLE ... RENAME reparses every view, so the two views that reference
-- the table are dropped there and recreated here verbatim:
-- `audit_event_effective_v` and `audit_integrity_violations_v`.
--
-- `board_eligibility_violations_v` is additionally REDEFINED. As created by
-- 0023 it also reported CONCLUDED terms: an ended legacy term with no
-- qualifying Lot (exactly what the backfill writes, and the one case that
-- NULL is legal for), and any early-ended term whose qualifying basis ended
-- with it — the normal result of the mutation boundary doing its job when an
-- Ownership or Representation ends. Eligibility is owed only while a term is
-- current or scheduled, so a concluded term is excluded rather than reported.
-- The ended-by-schedule exclusion needs "today"; `date('now')` is UTC while
-- Association Days are America/New_York, and for an operator-run integrity
-- view the few-hour skew on a term's final day is acceptable — authorization
-- SQL never reads this view.
--
-- Every statement is IF-guarded, so the file is safe to re-run.

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

DROP VIEW IF EXISTS board_eligibility_violations_v;
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
-- already ended, so an unconcluded term with no Lot is itself a violation.
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
  AND t.actual_end_day IS NULL
  AND date('now') < t.scheduled_end_day
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
