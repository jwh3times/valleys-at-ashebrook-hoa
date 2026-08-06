import { sql } from 'drizzle-orm';

export const LIVE_VOTING_ENABLED_SQL = `
  EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'site'
      AND CASE WHEN json_valid(value)
        THEN json_type(value, '$.officialMode') = 'true'
         AND json_type(value, '$.liveVotingEnabled') = 'true'
        ELSE 0
      END
  )
` as const;

export const liveVotingEnabledInDb = sql.raw(LIVE_VOTING_ENABLED_SQL);
