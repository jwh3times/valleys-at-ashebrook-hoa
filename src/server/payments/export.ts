import type { DuesLedgerKind } from '../../lib/types';
import { DUES_LEDGER_KIND_LABELS } from '../../lib/lot-records';
import { formatLotLabel } from '../../lib/format';

/**
 * THE TREASURER'S EXPORT OF PROVIDER-SOURCED ENTRIES (ADR 0025, #546).
 *
 * Payout-to-bank matching happens outside the site: the treasurer takes every
 * ledger entry the payment provider wrote over a range of Association Days
 * and lays it beside the association's bank statement. Board-recorded entries
 * are left out — they are not provider money, and the treasurer already holds
 * their paper.
 *
 * Read-only and board-wide: the caller has passed `requireBoard`.
 */

const HEADER = [
  'Effective day',
  'Lot',
  'Kind',
  'Amount',
  'Payment reference',
  'Entry id',
];

interface ExportRow {
  id: string;
  effective_day: string;
  kind: DuesLedgerKind;
  amount_cents: number;
  address: string;
  unit: string | null;
  plat_lot_number: string | null;
  provider_payment_ref: string | null;
}

/**
 * Every provider-sourced entry with `from <= effective_day <= to`, as CSV
 * (RFC 4180: CRLF line ends, a header row even when nothing matched).
 */
export async function exportProviderEntries(
  env: Env,
  range: { from: string; to: string },
): Promise<string> {
  const { results } = await env.DATABASE.prepare(
    `SELECT l.id, l.effective_day, l.kind, l.amount_cents,
            lot.address, lot.unit, lot.plat_lot_number,
            p.provider_payment_ref
       FROM dues_ledger_entries l
       JOIN lots lot ON lot.id = l.lot_id
       LEFT JOIN payments p ON p.id = l.payment_id
      WHERE l.source = 'provider'
        AND l.effective_day BETWEEN ? AND ?
      ORDER BY l.effective_day, l.recorded_at, l.id`,
  )
    .bind(range.from, range.to)
    .all<ExportRow>();

  const lines = [
    HEADER.map(textCell),
    ...results.map((r) => [
      textCell(r.effective_day),
      textCell(
        formatLotLabel({
          address: r.address,
          unit: r.unit,
          platLotNumber: r.plat_lot_number,
        }),
      ),
      textCell(DUES_LEDGER_KIND_LABELS[r.kind]),
      // Not through `textCell`: a negative amount starts with `-` and must
      // stay a number the treasurer can sum. It is built here from an
      // integer, so it is always `-?digits.dd` and never a formula.
      centsToCsv(r.amount_cents),
      textCell(r.provider_payment_ref ?? ''),
      textCell(r.id),
    ]),
  ];
  return lines.map((cells) => `${cells.join(',')}\r\n`).join('');
}

/**
 * A text cell, safe to open in a spreadsheet. A Lot's address is typed by
 * the board and a payment reference comes from the provider, so neither is
 * trusted: a value a spreadsheet would read as a formula (one starting `=`,
 * `+`, `-`, `@`, a tab or a carriage return) is prefixed with `'`, which
 * makes it plain text. Then RFC 4180 quoting, for a comma, a quote or a line
 * break.
 */
function textCell(value: string): string {
  const defused = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(defused)
    ? `"${defused.replaceAll('"', '""')}"`
    : defused;
}

/** `-45000` → `-450.00`, from the integers alone: no floating point. */
function centsToCsv(cents: number): string {
  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  return `${cents < 0 ? '-' : ''}${whole}.${String(remainder).padStart(2, '0')}`;
}
