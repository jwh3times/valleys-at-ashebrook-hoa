import { associationDateIso } from '../../lib/format';
import { paymentReference } from '../../lib/payments';
import { lotAuthorityExists } from '../roster/authority';
import { ONLINE_PAYMENTS_ENABLED_SQL } from './gate';
import type { PaymentProvider } from './provider';

/**
 * Starting a checkout (ADR 0025, #542): the only writer of a NEW `payments`
 * row, as `apply.ts` is the only writer of everything after.
 *
 * The provider's checkout is created FIRST, under a payment id minted here,
 * and the row is then written in one `INSERT … SELECT` that carries the
 * provider's reference and re-checks the three flags and the caller's Lot
 * Authority. So a row exists only for a checkout that exists, the row is never
 * updated afterwards (the projection's only updater stays the application
 * path), and a race lost between the preflight and the insert writes nothing.
 * The checkout it leaves behind is never shown to anyone and expires unpaid
 * within the hour.
 */

export type StartPayment =
  | { kind: 'started'; paymentId: string; url: string }
  /** The caller holds no Lot Authority over the Lot: the masked 404. */
  | { kind: 'not_found' }
  /** A flag turned off between the preflight and the insert. */
  | { kind: 'conflict' };

export interface StartPaymentInput {
  personId: string;
  lotId: string;
  /** Already checked against the payment bounds. */
  amountCents: number;
  /** The site's own origin (`BETTER_AUTH_URL`), never the request's `Host`. */
  siteUrl: string;
}

export async function startPayment(
  env: Env,
  provider: PaymentProvider,
  { personId: accountPersonId, lotId, amountCents, siteUrl }: StartPaymentInput,
  now: Date = new Date(),
): Promise<StartPayment> {
  const today = associationDateIso(now);
  // Two different questions, as `roster-and-access.md` separates them. Lot
  // Authority asks which Person this ACCOUNT is, so it resolves a
  // consolidated duplicate to its survivor, as membership did. The initiator
  // records who ACTED, so it is the account's own Person, unresolved.
  const holderId = await canonicalPerson(env, accountPersonId);
  if (!holderId || !(await holdsLot(env, holderId, lotId, today)))
    return { kind: 'not_found' };

  const paymentId = crypto.randomUUID();
  const returnUrl = `${siteUrl.replace(/\/+$/, '')}/lot-records/payments/${paymentId}`;
  const { providerPaymentRef, url } = await provider.createCheckout({
    paymentId,
    reference: paymentReference(paymentId),
    amountCents,
    returnUrl,
    // The same page: it shows the payment's stored status, whichever way the
    // homeowner left the provider's page.
    cancelUrl: returnUrl,
  });

  const authority = lotAuthorityExists(
    { value: holderId },
    { value: lotId },
    today,
  );
  const at = now.getTime();
  const result = await env.DATABASE.prepare(
    `INSERT INTO payments
       (id, lot_id, amount_cents, initiated_by_person_id, origin, provider,
        provider_payment_ref, status, ledger_state, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'checkout', ?, ?, 'created', 'none', ?, ?
     WHERE ${ONLINE_PAYMENTS_ENABLED_SQL} AND ${authority.sql}`,
  )
    .bind(
      paymentId,
      lotId,
      amountCents,
      accountPersonId,
      provider.id,
      providerPaymentRef,
      at,
      at,
      ...authority.binds,
    )
    .run();
  if (result.meta.changes === 1) return { kind: 'started', paymentId, url };
  // Which precondition went is worth telling apart: a Lot the caller no
  // longer holds is the masked 404, the same answer as one never held.
  return (await holdsLot(env, holderId, lotId, today))
    ? { kind: 'conflict' }
    : { kind: 'not_found' };
}

/** The Party an account's Person resolves to, one consolidation hop, as
 * `LOT_SQL` and the member reads resolve it; `null` for no such Party. */
async function canonicalPerson(
  env: Env,
  personId: string,
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    'SELECT COALESCE(consolidated_into_party_id, id) AS id FROM parties WHERE id = ?',
  )
    .bind(personId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function holdsLot(
  env: Env,
  personId: string,
  lotId: string,
  today: string,
): Promise<boolean> {
  const authority = lotAuthorityExists(
    { value: personId },
    { value: lotId },
    today,
  );
  const row = await env.DATABASE.prepare(`SELECT ${authority.sql} AS held`)
    .bind(...authority.binds)
    .first<{ held: number }>();
  return row?.held === 1;
}
