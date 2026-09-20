// Display vocabulary for Lot Records (ADR 0024, #291).
//
// Pure module, no server imports, so the board's panel and the homeowner's
// page read the SAME words. They are byte-identical today, and a category the
// two surfaces worded differently would be the board and the homeowner
// disagreeing about what was recorded.
//
// Every map is keyed by its union rather than by `string`: adding a value to
// `LOT_VIOLATION_CATEGORIES` must break the build here, not render a raw
// `special_assessment` to a homeowner.
import type {
  LotRecordAction,
  LotRecordReasonCode,
  LotViolationCategory,
  LotViolationStatus,
} from './types';

export const LOT_VIOLATION_CATEGORY_LABELS: Record<
  LotViolationCategory,
  string
> = {
  architectural: 'Architectural',
  maintenance: 'Maintenance',
  landscaping: 'Landscaping',
  parking: 'Parking',
  trash: 'Trash',
  pets: 'Pets',
  noise: 'Noise',
  other: 'Other',
};

export const LOT_VIOLATION_STATUS_LABELS: Record<LotViolationStatus, string> = {
  open: 'Open',
  cured: 'Cured',
  closed: 'Closed',
  voided: 'Voided',
};

/** Why a record moved or was voided. Board-facing: a homeowner never sees a
 * voided record, and therefore never sees a reason. */
export const LOT_RECORD_REASON_LABELS: Record<LotRecordReasonCode, string> = {
  entered_in_error: 'Entered in error',
  duplicate: 'Duplicate of another record',
  superseded: 'Superseded by a later record',
  homeowner_corrected: 'Homeowner corrected the record',
  board_decision: 'Board decision',
  other: 'Other',
};

/** What a `lot_record_events` row says happened, for the board's history view. */
export const LOT_RECORD_EVENT_LABELS: Record<LotRecordAction, string> = {
  created: 'Recorded',
  cured: 'Marked cured',
  closed: 'Closed',
  reopened: 'Reopened',
  voided: 'Voided',
  edited: 'Corrected',
};
