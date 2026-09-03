export const REPORT_CONTENT_RETENTION_DAYS = 90;
export const PURGED_REPORT_TOPIC = 'Report content removed';
export const PURGED_REPORT_MARKDOWN =
  '## Report content removed\n\nThe saved report text was removed under the 90-day retention policy.';

const DAY_MS = 24 * 60 * 60 * 1000;

function purgeStatement(
  database: D1Database,
  condition: string,
  conditionValues: Array<string | number>,
) {
  return database
    .prepare(
      `UPDATE reports
        SET topic = ?, content_md = ?, sources_json = '[]'
      WHERE ${condition}
        AND (topic <> ? OR content_md <> ? OR sources_json <> '[]')`,
    )
    .bind(
      PURGED_REPORT_TOPIC,
      PURGED_REPORT_MARKDOWN,
      ...conditionValues,
      PURGED_REPORT_TOPIC,
      PURGED_REPORT_MARKDOWN,
    );
}

/** A mutation-boundary statement used inside a roster-redaction D1 batch. */
export function purgeAllSavedReportContentStatement(
  database: D1Database,
  redactionEventId: string,
) {
  return purgeStatement(
    database,
    'EXISTS (SELECT 1 FROM audit_events WHERE id = ?)',
    [redactionEventId],
  );
}

/** Remove de-anonymized report text after the application retention window. */
export async function cleanupSavedReportContent(
  env: Env,
  now = new Date(),
): Promise<{ reportRows: number }> {
  // Drizzle's SQLite `timestamp` mode persists epoch SECONDS in D1.
  const cutoffSeconds = Math.floor(
    (now.getTime() - REPORT_CONTENT_RETENTION_DAYS * DAY_MS) / 1000,
  );
  const result = await purgeStatement(env.DATABASE, 'created_at < ?', [
    cutoffSeconds,
  ]).run();
  return { reportRows: result.meta.changes };
}
