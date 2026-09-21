import { describe, it, expect } from 'vitest';
import {
  parseDollarsToCents,
  formatCents,
  describeBalance,
  MAX_ENTRY_CENTS,
} from '../../src/lib/money';

/**
 * The conversion between what a person types and what the ledger stores.
 *
 * Every case here is a real way money software gets this wrong, not a
 * hypothetical: the float that rounds the wrong way, the blank that becomes
 * zero, the `.5` that becomes five cents, the third decimal place that gets
 * quietly dropped.
 */

describe('parsing a typed amount', () => {
  it('reads whole dollars, cents, and a single decimal place', () => {
    expect(parseDollarsToCents('450')).toEqual({ ok: true, cents: 45000 });
    expect(parseDollarsToCents('450.75')).toEqual({ ok: true, cents: 45075 });
    // `.5` is fifty cents. Reading it as five is the classic off-by-ten.
    expect(parseDollarsToCents('450.5')).toEqual({ ok: true, cents: 45050 });
    expect(parseDollarsToCents('0.05')).toEqual({ ok: true, cents: 5 });
  });

  it('samples the shapes that used to go wrong', () => {
    for (const [typed, cents] of [
      ['1.00', 100],
      ['1.005', null],
      ['8.16', 816],
      ['16.08', 1608],
      ['1.1', 110],
      ['1.10', 110],
      ['0.29', 29],
      ['1.115', null],
      ['999999.89', 99999989],
      // Above the single-entry bound, so refused — see the dedicated case.
      ['1234567.89', null],
    ] as const) {
      const parsed = parseDollarsToCents(typed);
      if (cents === null) expect(parsed.ok).toBe(false);
      else expect(parsed).toEqual({ ok: true, cents });
    }
  });

  it('converts exactly across the accepted range, against exact arithmetic', () => {
    // The property, not a handful of samples: every accepted value equals what
    // BigInt says it should, with no float anywhere in the reference. This is
    // what the previous version of this test claimed and did not do.
    //
    // A `Math.round(parseFloat(x) * 100)` implementation still passes, because
    // refusing a third decimal is what keeps rounding safe here — the two are
    // COUPLED. The digit arithmetic is what ships because it does not depend
    // on a guard somewhere else staying put.
    //
    // Mismatches are collected rather than asserted one by one, so a failure
    // names every input that disagreed instead of only the first.
    const dollars = [
      '0',
      '1',
      '7',
      '99',
      '450',
      '1000',
      '123456',
      '90071992547409',
    ];
    const centsSuffixes = ['', '.0', '.5', '.05', '.09', '.10', '.29', '.99'];
    const mismatches: string[] = [];

    for (const d of dollars)
      for (const c of centsSuffixes)
        for (const sign of ['', '-']) {
          const typed = `${sign}${d}${c}`;
          const parsed = parseDollarsToCents(typed);
          const fraction = c === '' ? '00' : c.slice(1).padEnd(2, '0');
          const exact = BigInt(d) * 100n + BigInt(fraction);
          const signed = sign === '-' ? -exact : exact;
          const refused = exact === 0n || exact > BigInt(MAX_ENTRY_CENTS);

          if (refused) {
            if (parsed.ok)
              mismatches.push(`${typed}: accepted, expected refusal`);
            continue;
          }
          if (!parsed.ok) {
            mismatches.push(`${typed}: refused, expected ${signed}`);
            continue;
          }
          if (BigInt(parsed.cents) !== signed)
            mismatches.push(
              `${typed}: got ${parsed.cents}, expected ${signed}`,
            );
        }

    expect(mismatches).toEqual([]);
  });

  it('refuses zero, however it is typed, and never yields negative zero', () => {
    const accepted = ['0', '0.00', '-0', '-0.00', '0.0'].filter(
      (zero) => parseDollarsToCents(zero).ok,
    );
    expect(accepted).toEqual([]);
  });

  it('refuses more than a single entry may be, in dollars', async () => {
    const parsed = parseDollarsToCents('2,000,000');
    expect(parsed.ok).toBe(false);
    // The message a board member reads talks in dollars, not in wire cents.
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/\$1,000,000/);
      expect(parsed.error).not.toMatch(/cents\)/);
    }
  });

  it('refuses a blank field rather than calling it zero', () => {
    for (const blank of ['', '   ']) {
      const parsed = parseDollarsToCents(blank);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/enter an amount/i);
    }
  });

  it('refuses more than two decimal places rather than rounding them away', () => {
    // A third decimal is a typo, not a rounding request — and silently
    // dropping it is how $1.239 becomes $1.23 in someone's account.
    const parsed = parseDollarsToCents('1.239');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/two decimal places/i);
  });

  it('refuses anything that is not a number', () => {
    for (const junk of ['abc', '4a5', '--5', '4.5.6', '.', '$', '1e3'])
      expect(parseDollarsToCents(junk).ok).toBe(false);
  });

  it('accepts the shapes people actually type', () => {
    expect(parseDollarsToCents('$450.75')).toEqual({ ok: true, cents: 45075 });
    expect(parseDollarsToCents('1,234.56')).toEqual({
      ok: true,
      cents: 123456,
    });
    expect(parseDollarsToCents(' 450 ')).toEqual({ ok: true, cents: 45000 });
    expect(parseDollarsToCents('-45.50')).toEqual({ ok: true, cents: -4550 });
  });

  it('refuses an amount too large to stay exact, at both guards', () => {
    // The first guard: the dollars themselves are past the safe range.
    expect(parseDollarsToCents('99999999999999999999').ok).toBe(false);
    // The second: the dollars are safe, but dollars * 100 + cents is not.
    expect(parseDollarsToCents('90071992547409.99').ok).toBe(false);
  });
});

describe('showing an amount', () => {
  it('formats cents as dollars, with the sign in front', () => {
    expect(formatCents(45075)).toBe('$450.75');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
    // The minus leads: buried inside the number, a credit reads as a debt.
    expect(formatCents(-4550)).toBe('-$45.50');
    // Sub-dollar negatives, where a naive `-${dollars}.${rest}` emits
    // `$-0.50` or drops the padding entirely.
    expect(formatCents(-1)).toBe('-$0.01');
    expect(formatCents(-50)).toBe('-$0.50');
    expect(formatCents(-99)).toBe('-$0.99');
    expect(formatCents(-100)).toBe('-$1.00');
  });

  it('round-trips whatever was typed', () => {
    for (const typed of [
      '450',
      '450.75',
      '0.05',
      '1,234.56',
      '-45.50',
      '-0.01',
    ]) {
      const parsed = parseDollarsToCents(typed);
      expect(parsed.ok).toBe(true);
      if (parsed.ok)
        expect(parseDollarsToCents(formatCents(parsed.cents))).toEqual(parsed);
    }
  });
});

describe('describing a balance', () => {
  it('says owed, credit, or nothing — never a bare signed number', () => {
    expect(describeBalance(45000)).toBe('$450.00 owed');
    expect(describeBalance(-4550)).toBe('$45.50 in credit');
    expect(describeBalance(0)).toBe('Nothing owed');
  });
});
