import { sql } from 'drizzle-orm';
import { getSiteSettings } from '../content/settings';
import { LOT_RECORD_TYPES, type LotRecordType } from '../../lib/types';

export { LOT_RECORD_TYPES, type LotRecordType };

/**
 * TWO FLAGS, BOTH REQUIRED, BOTH FAIL-CLOSED (ADR 0024, #291).
 *
 * Every Lot Record surface requires `officialMode` AND `lotRecordsEnabled` to
 * be literal JSON `true`. `officialMode` alone must not turn this on: adopting
 * the site is a decision about presentation and homeowner business, while
 * publishing Lot-level financial and enforcement records is a separate decision
 * with its own readiness steps — data loaded, balances checked, notice given.
 * This mirrors `liveVotingEnabled` exactly, down to the shape of the predicate.
 *
 * `json_type(value, '$.key') = 'true'` rather than `json_extract`: SQLite has
 * no boolean type, so `json_extract` returns the integer 1 and would compare
 * equal to a stored JSON number or the string "true". Only `json_type` asks
 * what the stored value actually IS. A missing key returns NULL and so reads as
 * off, which is the same absent-means-false reading `normalizeSiteSettings`
 * gives it.
 */
export const LOT_RECORDS_ENABLED_SQL = `
  EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'site'
      AND CASE WHEN json_valid(value)
        THEN json_type(value, '$.officialMode') = 'true'
         AND json_type(value, '$.lotRecordsEnabled') = 'true'
        ELSE 0
      END
  )
` as const;

export const lotRecordsEnabledInDb = sql.raw(LOT_RECORDS_ENABLED_SQL);

/**
 * The read-time half of the same gate, for a route or page deciding whether the
 * surface exists at all. A mutation must ALSO re-check
 * `LOT_RECORDS_ENABLED_SQL` inside its own statement: a preflight that passed a
 * round trip ago is exactly what a race invalidates, and a board edit landing
 * while the flags are being turned off has to answer 409 rather than write.
 *
 * `getSiteSettings` fails closed to both flags off, so an unreadable or
 * malformed settings row hides the surface rather than exposing it.
 */
export async function lotRecordsAvailable(env: Env): Promise<boolean> {
  const site = await getSiteSettings(env);
  return site.officialMode && site.lotRecordsEnabled;
}
