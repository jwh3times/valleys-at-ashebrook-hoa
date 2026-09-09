-- Apply before deploying Better Auth 1.7.3 with database rate limiting (#316).
-- Additive: the previous application version can run with this table present.
CREATE TABLE rate_limits (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);
