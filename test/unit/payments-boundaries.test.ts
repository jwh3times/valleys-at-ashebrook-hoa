import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PAYMENT_EVENT_OUTCOMES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_EVENT_VIAS,
  PAYMENT_EXCEPTION_REASONS,
  PAYMENT_LEDGER_STATES,
  PAYMENT_ORIGINS,
  PAYMENT_RESOLUTIONS,
  PAYMENT_STATUSES,
} from '../../src/lib/types';

/**
 * The static half of ADR 0025's payment guarantees (#539).
 *
 * What these forbid is code that does not exist yet, so no query can prove
 * them:
 *
 * 1. **Nothing outside the adapter directory names the provider.** That is
 *    what keeps the provider choice reversible: schema, ledger, gates and
 *    board surfaces never move when it changes.
 * 2. **One module writes the payment tables.** Every path to a provider fact
 *    goes through the application path in `src/server/payments/`, which is
 *    where both idempotency layers live; a second writer would be a second
 *    way to credit a Lot.
 * 3. **The event, exception and resolution tables are append-only**, and the
 *    `payments` projection is updated by the application path alone.
 * 4. **The vocabulary in `src/lib/types.ts` and the migration's CHECKs agree.**
 *
 * Every pattern is built by string CONCATENATION with doubled backslashes,
 * never inside a template literal, where `\b` silently becomes a backspace and
 * the pattern matches nothing (see `lot-records-boundaries.test.ts`). Each scan
 * also proves it can see a planted violation, so a pattern that matches
 * nothing fails here instead of reporting green.
 */

const SRC = join(process.cwd(), 'src');
const PAYMENTS_DIR = 'server/payments/';
const ADAPTER_DIR = 'server/payments/providers/';
const APPLICATION_PATH = 'server/payments/apply.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

const relative = (file: string) =>
  file
    .slice(SRC.length + 1)
    .split('\\')
    .join('/');

const FILES = sourceFiles(SRC).map((file) => ({
  rel: relative(file),
  text: readFileSync(file, 'utf8'),
}));

it('found the source tree to scan', () => {
  expect(FILES.length).toBeGreaterThan(100);
  expect(FILES.some((f) => f.rel === APPLICATION_PATH)).toBe(true);
});

describe('the provider stays behind the adapter boundary', () => {
  /**
   * Provider names, and their API hosts. A new adapter adds its own name here
   * in the same change, so the boundary covers it from its first commit.
   */
  const PROVIDER_NAMES = ['stripe'];

  /**
   * Copy written for residents, which must name the provider that processes
   * their payment — never code. Each entry is a deliberate exception.
   */
  const COPY_PAGES = new Set(['pages/privacy.astro']);

  const namesAProvider = (text: string) =>
    PROVIDER_NAMES.filter((name) =>
      new RegExp('\\b' + name + '\\b', 'i').test(text),
    );

  it('detects a provider named in code, so the scan cannot be vacuous', () => {
    expect(namesAProvider("import Stripe from 'stripe';")).toEqual(['stripe']);
    expect(namesAProvider('fetch("https://api.stripe.com/v1/events")')).toEqual(
      ['stripe'],
    );
    expect(namesAProvider('the payment provider')).toEqual([]);
  });

  it('finds no provider name outside the adapter directory', () => {
    const offenders = FILES.filter(
      (f) => !f.rel.startsWith(ADAPTER_DIR) && !COPY_PAGES.has(f.rel),
    ).flatMap((f) => namesAProvider(f.text).map((n) => `${f.rel}: ${n}`));
    expect(offenders).toEqual([]);
  });
});

describe('one module writes the payment tables', () => {
  const TABLES: Record<string, string> = {
    payments: 'payments',
    payment_events: 'paymentEvents',
    payment_exceptions: 'paymentExceptions',
    payment_exception_resolutions: 'paymentExceptionResolutions',
  };

  /** Every write to a payment table in one source text. */
  function writes(text: string): string[] {
    const bare = text.replace(/["`]/g, '');
    const found: string[] = [];
    for (const [table, identifier] of Object.entries(TABLES)) {
      if (new RegExp('INSERT\\s+INTO\\s+' + table + '\\b', 'i').test(bare))
        found.push(`INSERT INTO ${table}`);
      if (new RegExp('UPDATE\\s+' + table + '\\b', 'i').test(bare))
        found.push(`UPDATE ${table}`);
      if (new RegExp('DELETE\\s+FROM\\s+' + table + '\\b', 'i').test(bare))
        found.push(`DELETE FROM ${table}`);
      for (const verb of ['insert', 'update', 'delete'])
        if (
          new RegExp('\\.' + verb + '\\(\\s*' + identifier + '\\s*\\)').test(
            text,
          )
        )
          found.push(`.${verb}(${identifier})`);
    }
    return found;
  }

  it('detects each kind of write, so the scan cannot be vacuous', () => {
    expect(writes('INSERT INTO payment_events (id) VALUES (?)')).toEqual([
      'INSERT INTO payment_events',
    ]);
    expect(writes('`UPDATE payments SET status = ?`')).toEqual([
      'UPDATE payments',
    ]);
    expect(writes('db.delete(paymentExceptions)')).toEqual([
      '.delete(paymentExceptions)',
    ]);
    // `payments` must not be read as a prefix of `payment_events`.
    expect(writes('INSERT INTO payment_eventsX')).toEqual([]);
  });

  it('has no write to a payment table outside the payments module', () => {
    const offenders = FILES.filter(
      (f) => !f.rel.startsWith(PAYMENTS_DIR),
    ).flatMap((f) => writes(f.text).map((w) => `${f.rel}: ${w}`));
    expect(offenders).toEqual([]);
  });

  it('never updates or deletes an event, exception or resolution', () => {
    const appendOnly = [
      'payment_events',
      'payment_exceptions',
      'payment_exception_resolutions',
      'paymentEvents',
      'paymentExceptions',
      'paymentExceptionResolutions',
    ];
    const offenders = FILES.flatMap((f) =>
      writes(f.text)
        .filter((w) => !w.startsWith('INSERT') && !w.startsWith('.insert'))
        .filter((w) =>
          appendOnly.some((t) => w.endsWith(t) || w.endsWith(t + ')')),
        )
        .map((w) => `${f.rel}: ${w}`),
    );
    expect(offenders).toEqual([]);
  });

  it('updates the payments projection from the application path alone', () => {
    const offenders = FILES.filter((f) => f.rel !== APPLICATION_PATH).flatMap(
      (f) =>
        writes(f.text)
          .filter((w) => w === 'UPDATE payments' || w === '.update(payments)')
          .map((w) => `${f.rel}: ${w}`),
    );
    expect(offenders).toEqual([]);
    expect(
      writes(FILES.find((f) => f.rel === APPLICATION_PATH)!.text),
    ).toContain('UPDATE payments');
  });

  it('never deletes a payment', () => {
    const offenders = FILES.flatMap((f) =>
      writes(f.text)
        .filter(
          (w) => w === 'DELETE FROM payments' || w === '.delete(payments)',
        )
        .map((w) => `${f.rel}: ${w}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the payment vocabulary matches the database', () => {
  const MIGRATION = readFileSync(
    join(SRC, 'server', 'db', 'migrations', '0046_payments.sql'),
    'utf8',
  );

  /** The quoted values of one CHECK's `IN (...)` list, by slicing. */
  function checkValues(constraint: string): string[] {
    const at = MIGRATION.indexOf(`CONSTRAINT "${constraint}"`);
    const open = MIGRATION.indexOf('IN (', at);
    const close = MIGRATION.indexOf(')', open);
    if (at < 0 || open < 0 || close < 0)
      throw new Error(`no IN list on ${constraint}`);
    return MIGRATION.slice(open + 'IN ('.length, close)
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''));
  }

  const PINS: Record<string, readonly string[]> = {
    payments_origin_check: PAYMENT_ORIGINS,
    payments_status_check: PAYMENT_STATUSES,
    payments_ledger_state_check: PAYMENT_LEDGER_STATES,
    payment_events_type_check: PAYMENT_EVENT_TYPES,
    payment_events_via_check: PAYMENT_EVENT_VIAS,
    payment_events_outcome_check: PAYMENT_EVENT_OUTCOMES,
    payment_exceptions_reason_check: PAYMENT_EXCEPTION_REASONS,
    payment_exception_resolutions_resolution_check: PAYMENT_RESOLUTIONS,
  };

  it.each(Object.entries(PINS))(
    'bounds %s to its TypeScript list',
    (name, list) => {
      expect(checkValues(name)).toEqual([...list]);
    },
  );

  it('pins every value-list CHECK on a payment table', () => {
    const found = [
      ...MIGRATION.matchAll(/CONSTRAINT "([a-z_]+)" CHECK\([^)]*?IN \(/g),
    ].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    // `payment_events_entry_by_outcome` relates two columns; its IN list is a
    // subset of the outcomes, not a vocabulary of its own.
    for (const name of found.filter(
      (n) => n !== 'payment_events_entry_by_outcome',
    ))
      expect(Object.keys(PINS), `${name} has no pin`).toContain(name);
  });
});
