// The Access Event for a stored Board grant that failed re-validation at
// evaluation (#200's criterion, decided on #217 and implemented in 3b, #218).
//
// Derivation refuses `board` when a live grant's qualifying term has lapsed,
// been cancelled, or been voided; the refusal is complete without any record
// (see `DerivedAccess.invalidBoardGrantId`). This module writes the durable
// half: the survival of the grant is an integrity signal about the WRITE path
// — the mutation boundary should have ended it — and that is worth a permanent
// row.
//
// Attribution, per #217's option 1: an `actor_kind = 'account'` correlation
// root attributed to the DENIED caller — the same shape the ledger already
// accepts for the last-System-Administrator denial. The natural
// `actor_kind = 'automatic'` is schema-impossible at a root (an automatic
// event must name a `causing_event_id`; a root must not have one), and an
// evaluation-time finding has no initiating command to descend from.
//
// Day-idempotent: the operation key is `grant-revalidation:<grant>:<day>`, so
// a caller hammering the API writes one row per grant per Association Day.
// The envelope inserts only where that key is absent, and the detail row is
// gated on the envelope's own id, so a duplicate day produces zero rows in
// both tables. Two same-instant racers can still collide on the key's unique
// index — that aborts the loser's batch, which the caller below swallows.

/** Fire-and-forget by contract: NEVER throws.
 *
 * Evaluation must not 500 because the ledger write failed — the denial itself
 * already happened, and a derivation error presenting as a permissions bug is
 * exactly what `getAuthContext` promises not to manufacture. The next request
 * retries harmlessly under the same idempotency key.
 */
export async function recordGrantRevalidationDenial(
  env: Env,
  opts: { accountId: string; grantId: string; associationDay: string },
): Promise<void> {
  const eventId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const operationKey = `grant-revalidation:${opts.grantId}:${opts.associationDay}`;
  try {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, causing_event_id, actor_kind, actor_account_id, automatic_cause, operation_key, recorded_at)
         SELECT ?1, 'access', 'grant_precondition_revalidation', ?2, 0, NULL, 'account', ?3, NULL, ?4, ?5
         WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE operation_key = ?4)`,
      ).bind(eventId, correlationId, opts.accountId, operationKey, Date.now()),
      env.DATABASE.prepare(
        `INSERT INTO access_events (event_id, access_grant_id, target_account_id, grant_type, requested_action, outcome, reason_code)
         SELECT ?1, ?2, ?3, 'board', 'grant_precondition_revalidation', 'denied', 'qualifying_term_invalid'
         WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?1)`,
      ).bind(eventId, opts.grantId, opts.accountId),
    ]);
  } catch {
    // Swallowed by design — see the contract above.
  }
}
