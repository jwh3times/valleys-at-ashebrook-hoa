export const REPORT_CONTENT_RETENTION_DAYS = 90;
export const PURGED_REPORT_TOPIC = 'Report content removed';
export const PURGED_REPORT_MARKDOWN =
  '## Report content removed\n\nThe saved report text was removed under the 90-day retention policy.';

const DAY_MS = 24 * 60 * 60 * 1000;

function purgeStatement(database: D1Database, cutoffSeconds?: number) {
  const cutoffClause = cutoffSeconds === undefined ? '' : 'created_at < ? AND ';
  const statement = database.prepare(
    `UPDATE reports
        SET topic = ?, content_md = ?, sources_json = '[]'
      WHERE ${cutoffClause}(topic <> ? OR content_md <> ? OR sources_json <> '[]')`,
  );
  const values = [
    PURGED_REPORT_TOPIC,
    PURGED_REPORT_MARKDOWN,
    ...(cutoffSeconds === undefined ? [] : [cutoffSeconds]),
    PURGED_REPORT_TOPIC,
    PURGED_REPORT_MARKDOWN,
  ];
  return statement.bind(...values);
}

/** A mutation-boundary statement used inside a roster-redaction D1 batch. */
export function purgeAllSavedReportContentStatement(
  database: D1Database,
  redactionEventId: string,
) {
  return database
    .prepare(
      `UPDATE reports
          SET topic = ?, content_md = ?, sources_json = '[]'
        WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
          AND (topic <> ? OR content_md <> ? OR sources_json <> '[]')`,
    )
    .bind(
      PURGED_REPORT_TOPIC,
      PURGED_REPORT_MARKDOWN,
      redactionEventId,
      PURGED_REPORT_TOPIC,
      PURGED_REPORT_MARKDOWN,
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
  const result = await purgeStatement(env.DATABASE, cutoffSeconds).run();
  return { reportRows: result.meta.changes };
}
