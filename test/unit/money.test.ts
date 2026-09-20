import { describe, it, expect } from 'vitest';
import {
  parseDollarsToCents,
  formatCents,
  describeBalance,
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

  it('converts exactly across the whole accepted range', () => {
    // An honest note, because I checked: a `Math.round(parseFloat(x) * 100)`
    // implementation ALSO passes this test. Within two decimal places the
    // scaling error is around 1e-13 and `round` always rescues it, so no
    // input in the accepted domain discriminates between the two.
    //
    // The digit arithmetic is still what is implemented, because the two are
    // otherwise COUPLED: rounding is only safe here because the shape check
    // refuses a third decimal, so anyone who later relaxes that regex — to
    // accept `1.005`, say — would silently reintroduce the classic bug
    // (`Math.round(1.005 * 100)` is 100, not 101). Exact-by-construction
    // conversion does not depend on a guard somewhere else staying put.
    for (const [typed, cents] of [
      ['1.005'.slice(0, 4), 100], // '1.00'
      ['1.005', null],
      ['8.16', 816],
      ['16.08', 1608],
      ['1.1', 110],
      ['1.10', 110],
      ['0.29', 29],
      ['1.115', null],
      ['1234567.89', 123456789],
    ] as const) {
      const parsed = parseDollarsToCents(typed);
      if (cents === null) expect(parsed.ok).toBe(false);
      else expect(parsed).toEqual({ ok: true, cents });
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

  it('refuses an amount too large to stay exact', () => {
    expect(parseDollarsToCents('99999999999999999999').ok).toBe(false);
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
  });

  it('round-trips whatever was typed', () => {
    for (const typed of ['450', '450.75', '0.05', '1,234.56', '-45.50']) {
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
