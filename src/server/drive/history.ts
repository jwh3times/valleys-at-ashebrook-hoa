// The Drive connection's history in `setting_changes` (#290 slice 2, spec
// decision 1): statuses only (`none`, `connected`, `broken`), never a token
// or a scope. Each entry is appended in the same D1 batch as the write it
// records and lands only if that write changed the row (`changes() = 1`), so
// a lost compare-and-swap records nothing.

export const DRIVE_HISTORY_KEY = 'drive_connection';

/** The actor recorded for an automatic change, such as the keepalive. */
export const SCHEDULED_JOB_ACTOR = 'scheduled-job';

export function recordDriveConnectionChange(
  env: Env,
  oldValue: string,
  newValue: string,
  actingAccountId: string,
  recordedAt: number,
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO setting_changes (id, key, old_value, new_value, acting_account_id, recorded_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
  ).bind(
    crypto.randomUUID(),
    DRIVE_HISTORY_KEY,
    oldValue,
    newValue,
    actingAccountId,
    recordedAt,
  );
}
