import { isWriteFrozen } from '../authz/write-freeze';
import { applyPaymentEvent, openStalePendingExceptions } from './apply';
import type { PaymentProvider } from './provider';
import { paymentProviderFor } from './registry';

/**
 * The daily reconciliation job (ADR 0025, #543): a missed or delayed webhook
 * never loses a payment for more than a day.
 *
 * In order, each half independent of the other:
 *
 * 1. **The provider's events since the stored cursor**, each applied through
 *    the application path. Read first, because an event carries the provider's
 *    own time for the fact, which is the date a credit should carry. The
 *    cursor advances only when the listing and every fact in it were recorded;
 *    otherwise tomorrow reads the same span again, and per-event idempotency
 *    makes that free.
 * 2. **A pull of every payment still `created` or `pending` an hour after it
 *    started**, for what the event list no longer has: a provider keeps
 *    events for a limited time (the first adapter's keeps 30 days), and the
 *    payment's own state outlives them. One failed pull is named and the rest go on; it never
 *    holds the cursor, so one stuck payment cannot let events age out.
 * 3. **`stale_pending`** for anything still pending ten days on, after the
 *    pulls, so a payment this run settled is not flagged.
 *
 * Everything goes through `applyPaymentEvent`, so a fact the webhook already
 * delivered is a duplicate and changes nothing. It skips with no provider
 * configured, and during the write freeze, as the webhook refuses then too;
 * the next run catches up. It reads no site flag: ingestion never does.
 *
 * Logs carry ids and counts only, never a payload.
 */

/** A checkout younger than this is left to its webhook. */
const PULL_AFTER_MS = 60 * 60 * 1000;

/**
 * Its own `settings` row, so the whole-blob Site Settings `PUT` (which writes
 * only `site`) can never move it.
 */
const CURSOR_KEY = 'payments_event_cursor';

export interface ReconcileRun {
  /** Why nothing ran, or `null` when it did. */
  skipped: 'unconfigured' | 'frozen' | null;
  /** Facts the event list reported and the application path took. */
  listed: number;
  /** The event list could not be read or one of its facts recorded. */
  eventListFailed: boolean;
  /** Payments whose state was pulled. */
  pulled: number;
  /** Payment ids whose pull failed. */
  failedPulls: string[];
  /** Payment ids that `stale_pending` was opened for. */
  stalePending: string[];
}

export async function reconcilePayments(
  env: Env,
  now: Date = new Date(),
): Promise<ReconcileRun> {
  const run: ReconcileRun = {
    skipped: null,
    listed: 0,
    eventListFailed: false,
    pulled: 0,
    failedPulls: [],
    stalePending: [],
  };
  const provider = paymentProviderFor(env);
  if (!provider) return { ...run, skipped: 'unconfigured' };
  if (await isWriteFrozen(env)) return { ...run, skipped: 'frozen' };

  try {
    run.listed = await ingestEventsSinceCursor(env, provider, now);
  } catch (error) {
    run.eventListFailed = true;
    console.error('[payments-reconcile] the event list was not recorded', {
      provider: provider.id,
      error: errorName(error),
    });
  }

  for (const { id, ref } of await paymentsToPull(env, provider, now)) {
    run.pulled += 1;
    try {
      for (const fact of await provider.retrievePayment(ref))
        await applyPaymentEvent(env, fact, now);
    } catch (error) {
      run.failedPulls.push(id);
      console.error('[payments-reconcile] a payment could not be pulled', {
        provider: provider.id,
        paymentId: id,
        error: errorName(error),
      });
    }
  }

  run.stalePending = await openStalePendingExceptions(env, now);
  return run;
}

/** Applies the listed facts in order, stopping at the first that fails. */
async function ingestEventsSinceCursor(
  env: Env,
  provider: PaymentProvider,
  now: Date,
): Promise<number> {
  const { events, nextCursor } = await provider.listEventsSince(
    await readCursor(env, provider.id),
  );
  for (const fact of events) await applyPaymentEvent(env, fact, now);
  if (nextCursor !== null) await writeCursor(env, provider.id, nextCursor, now);
  return events.length;
}

async function paymentsToPull(
  env: Env,
  provider: PaymentProvider,
  now: Date,
): Promise<{ id: string; ref: string }[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, provider_payment_ref AS ref FROM payments
      WHERE provider = ? AND status IN ('created', 'pending')
        AND provider_payment_ref IS NOT NULL AND created_at <= ?
      ORDER BY created_at, id`,
  )
    .bind(provider.id, now.getTime() - PULL_AFTER_MS)
    .all<{ id: string; ref: string }>();
  return results;
}

/**
 * The cursor this provider minted, or `null`. A cursor another adapter minted
 * means nothing to this one, so a changed provider starts over; the overlap
 * costs nothing, since every fact is stored once.
 */
async function readCursor(
  env: Env,
  providerId: string,
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    'SELECT value FROM settings WHERE key = ?',
  )
    .bind(CURSOR_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const stored = JSON.parse(row.value) as unknown;
    if (
      typeof stored === 'object' &&
      stored !== null &&
      'provider' in stored &&
      'cursor' in stored &&
      stored.provider === providerId &&
      typeof stored.cursor === 'string'
    )
      return stored.cursor;
  } catch {
    // An unreadable cursor is no cursor: reading from the start is safe.
  }
  return null;
}

async function writeCursor(
  env: Env,
  providerId: string,
  cursor: string,
  now: Date,
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = excluded.updated_at`,
  )
    .bind(
      CURSOR_KEY,
      JSON.stringify({ provider: providerId, cursor }),
      Math.floor(now.getTime() / 1000),
    )
    .run();
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : typeof error;
