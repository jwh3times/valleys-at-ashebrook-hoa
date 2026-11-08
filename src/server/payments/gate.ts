import type { SiteSettings } from '../../lib/types';
import { lotRecordsVisible } from '../lot-records/gate';
import { paymentProviderFor } from './registry';

/**
 * WHEN A HOMEOWNER MAY START A PAYMENT (ADR 0025, #538).
 *
 * Three flags, all literal JSON `true`, and a configured provider:
 * `officialMode` and `lotRecordsEnabled` (the payment lands on the Lot's dues
 * ledger, which those two publish) and `onlinePaymentsEnabled`. Fail-closed:
 * anything else and every way to start a payment is the 404.
 *
 * This gates STARTING only. Ingestion never reads a flag, and reading or
 * chasing a payment already in flight needs the first two alone, so turning
 * online payments off never strands a payment a homeowner already made.
 */

/**
 * The mutation-boundary half, for the `INSERT … SELECT` that records a new
 * payment: a preflight that passed a round trip ago is what a race
 * invalidates. `json_type` for the reason `LOT_RECORDS_ENABLED_SQL` gives:
 * only it tells a stored `true` from `1` or `"true"`.
 */
export const ONLINE_PAYMENTS_ENABLED_SQL = `
  EXISTS (
    SELECT 1 FROM settings
    WHERE key = 'site'
      AND CASE WHEN json_valid(value)
        THEN json_type(value, '$.officialMode') = 'true'
         AND json_type(value, '$.lotRecordsEnabled') = 'true'
         AND json_type(value, '$.onlinePaymentsEnabled') = 'true'
        ELSE 0
      END
  )
` as const;

/**
 * The read-time half: whether this deployment offers starting a payment at
 * all, for a guard or a page deciding whether the surface exists.
 */
export function paymentsStartable(
  site: Pick<
    SiteSettings,
    'officialMode' | 'lotRecordsEnabled' | 'onlinePaymentsEnabled'
  >,
  env: Env,
): boolean {
  return (
    lotRecordsVisible(site) &&
    site.onlinePaymentsEnabled &&
    paymentProviderFor(env) !== null
  );
}
