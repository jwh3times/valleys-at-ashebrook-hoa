import { describe, it, expect } from 'vitest';
import {
  findContactValues,
  isAllowedEmail,
  isSyntheticPhone,
} from '../../scripts/check-fixture-values';

// The synthetic-fixture gate (`npm run lint:fixtures`).
//
// Inputs are assembled at run time so this file never holds a contact value in
// the shape the gate looks for — the gate scans its own tests, and a literal
// non-synthetic number here would fail the very build that runs them.

const phone = (area: string, exchange: string, line = '0100') =>
  `(${area}) ${exchange}-${line}`;
const email = (local: string, domain: string) => `${local}@${domain}`;

describe('isSyntheticPhone', () => {
  it('accepts the NANP fictional shapes', () => {
    expect(isSyntheticPhone('555', '123')).toBe(true);
    expect(isSyntheticPhone('919', '555')).toBe(true);
    expect(isSyntheticPhone('919', '000')).toBe(true);
    expect(isSyntheticPhone('919', '123')).toBe(true);
  });

  it('rejects an assignable area code and exchange', () => {
    expect(isSyntheticPhone('919', '867')).toBe(false);
    expect(isSyntheticPhone('630', '707')).toBe(false);
  });
});

describe('isAllowedEmail', () => {
  it('accepts the RFC 2606 reserved names, case-insensitively', () => {
    expect(isAllowedEmail(email('a', 'example.com'))).toBe(true);
    expect(isAllowedEmail(email('a', 'Example.ORG'))).toBe(true);
    expect(isAllowedEmail(email('a', 'mail.example.net'))).toBe(true);
    expect(isAllowedEmail(email('a', 'b.test'))).toBe(true);
    expect(isAllowedEmail(email('a', 'acme.example'))).toBe(true);
    expect(isAllowedEmail(email('a', 'host.invalid'))).toBe(true);
  });

  it('accepts the published contact addresses and infrastructure hosts', () => {
    expect(isAllowedEmail(email('git', 'github.com'))).toBe(true);
    expect(isAllowedEmail(email('xxxx', 'group.calendar.google.com'))).toBe(
      true,
    );
  });

  it('rejects a consumer mail provider and a look-alike of a reserved name', () => {
    expect(isAllowedEmail(email('resident', 'gmail.com'))).toBe(false);
    expect(isAllowedEmail(email('resident', 'sbcglobal.net'))).toBe(false);
    expect(isAllowedEmail(email('a', 'notexample.com'))).toBe(false);
    expect(isAllowedEmail(email('a', 'example.co'))).toBe(false);
  });
});

describe('findContactValues', () => {
  it('passes a source made only of reserved values', () => {
    const source = [
      `const cell = '${phone('919', '555', '0101')}, ${phone('555', '010')}';`,
      `const e164 = '+1919${'555'}0101';`,
      `const owner = '${email('alex', 'example.com')}';`,
      `const other = '${email('riley', 'x.test')}';`,
    ].join('\n');
    expect(findContactValues(source)).toEqual([]);
  });

  it('flags a phone number with an assignable area code and exchange, in every spelling', () => {
    const spellings = [
      phone('919', '867', '5309'),
      `919.${'867'}.5309`,
      `919-${'867'}-5309`,
      `+1919${'867'}5309`,
      `1 919 ${'867'} 5309`,
      `919${'867'}5309`,
    ];
    const flagged = spellings.filter(
      (s) =>
        JSON.stringify(findContactValues(`x = '${s}'`)) ===
        JSON.stringify([{ line: 1, kind: 'phone number' }]),
    );
    expect(flagged).toEqual(spellings);
  });

  it('flags an email address outside the reserved names', () => {
    const source = `const e = '${email('someone', 'gmail.com')}';`;
    expect(findContactValues(source)).toEqual([
      { line: 1, kind: 'email address' },
    ]);
  });

  it('reports one finding per line and kind, and never the value', () => {
    const source = [
      `a = '${phone('919', '867')} ${phone('984', '221')}'`,
      `b = '${email('one', 'yahoo.com')}'`,
      `c = '${phone('919', '867')} ${email('two', 'aol.com')}'`,
    ].join('\n');
    const findings = findContactValues(source);
    expect(findings).toEqual([
      { line: 1, kind: 'phone number' },
      { line: 2, kind: 'email address' },
      { line: 3, kind: 'phone number' },
      { line: 3, kind: 'email address' },
    ]);
    expect(JSON.stringify(findings)).not.toContain('867');
    expect(JSON.stringify(findings)).not.toContain('yahoo');
  });

  it('ignores package names, version pins, clone URLs, and calendar ids', () => {
    const source = [
      `import cf from '@astrojs/cloudflare';`,
      `// pinned at oxlint@1.79.0 and better-auth@1.6.30`,
      `const url = 'git@github.com:owner/repo.git';`,
      `PUBLIC_CALENDAR_ID=xxxxx@group.calendar.google.com`,
    ].join('\n');
    expect(findContactValues(source)).toEqual([]);
  });

  it('does not read a digit run inside a longer number or an identifier as a phone', () => {
    const source = [
      `const parcel = 'Parcel 12345678901234 recorded.';`,
      `const stamp = 1725500000000;`,
      `const id = 'a9198675309b';`,
      `const hash = 'sha512-AbC9198675309+xyz==';`,
    ].join('\n');
    expect(findContactValues(source)).toEqual([]);
  });

  it('does not join a number split across two lines', () => {
    const source = `const a = 919;\nconst b = '${'867'}-5309';`;
    expect(findContactValues(source)).toEqual([]);
  });

  it('honours the allow marker on the same line only', () => {
    const marker = ['fixture', 'ok'].join('-');
    const source = [
      `const a = '${phone('919', '867')}'; // ${marker}: probing the pseudonymizer`,
      `const b = '${phone('919', '867')}';`,
    ].join('\n');
    expect(findContactValues(source)).toEqual([
      { line: 2, kind: 'phone number' },
    ]);
  });
});
