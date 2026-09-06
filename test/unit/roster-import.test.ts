import { describe, it, expect } from 'vitest';
import {
  rowsToRoster,
  firstEmail,
  firstPhoneE164,
} from '../../scripts/import-roster';

// Every contact value here is a reserved synthetic value — NANP 555-01XX
// numbers and RFC 2606 example domains — and `npm run lint:fixtures` keeps it
// that way. The shapes are what the import has to cope with: labeled
// multi-value cells, doubled spaces, a phone shared by two owners.

describe('firstPhoneE164', () => {
  it('takes the first number from a labeled, multi-number cell as E.164', () => {
    expect(firstPhoneE164('Alex (919) 555-0101, Jamie (919) 555-0102')).toBe(
      '+19195550101',
    );
    expect(
      firstPhoneE164('Cell Phone: (919) 555-0103,  Home Phone: (919) 555-0104'),
    ).toBe('+19195550103');
    expect(firstPhoneE164('919.555.0101')).toBe('+19195550101');
  });

  it('returns null when there is no usable phone', () => {
    expect(firstPhoneE164('')).toBeNull();
    expect(firstPhoneE164(undefined)).toBeNull();
    expect(firstPhoneE164('n/a')).toBeNull();
  });
});

describe('firstEmail', () => {
  it('takes the first address from a multi-email cell', () => {
    expect(firstEmail('alex@example.com, jamie@example.org')).toBe(
      'alex@example.com',
    );
  });

  it('returns null when empty', () => {
    expect(firstEmail('')).toBeNull();
    expect(firstEmail(undefined)).toBeNull();
  });
});

describe('rowsToRoster', () => {
  it('maps a row to one property + its first homeowner', () => {
    const { properties, owners } = rowsToRoster([
      {
        'Homeowner 1': 'Alex Example',
        'Homeowner 1 Phone': '(919) 555-0101',
        'Homeowner 1 Email': 'alex@example.com',
        'Property Address': '100 Sample Loop Raleigh, NC  27603',
        'Unit No': '',
      } as Record<string, string>,
    ]);
    expect(properties).toHaveLength(1);
    expect(properties[0].addressNormalized).toBe(
      '100 sample loop raleigh nc 27603',
    );
    expect(properties[0].unit).toBeNull();
    expect(owners).toHaveLength(1);
    expect(owners[0].propertyId).toBe(properties[0].id);
    expect(owners[0].fullName).toBe('Alex Example');
    expect(owners[0].phone).toBe('+19195550101');
    expect(owners[0].email).toBe('alex@example.com');
  });

  it('emits a second owner when Homeowner 2 is present, sharing the propertyId', () => {
    const { owners } = rowsToRoster([
      {
        'Homeowner 1': 'Morgan Q. Sample',
        'Homeowner 1 Phone': '(312) 555-0105',
        'Homeowner 2': 'Riley P. Sample',
        'Homeowner 2 Phone': '(312) 555-0105',
        'Homeowner 2 Email': 'riley@example.net',
        'Property Address': '102 Sample Loop Raleigh, NC  27603',
      } as Record<string, string>,
    ]);
    expect(owners).toHaveLength(2);
    expect(owners[0].propertyId).toBe(owners[1].propertyId);
    expect(owners[0].phone).toBe('+13125550105');
    expect(owners[1].phone).toBe('+13125550105'); // shared phone preserved
    expect(owners[1].email).toBe('riley@example.net');
  });

  it('emits a single owner when Homeowner 2 is blank', () => {
    const { owners } = rowsToRoster([
      {
        'Homeowner 1': 'Solo Owner',
        'Homeowner 1 Phone': '(919) 555-0106',
        'Homeowner 2': '',
        'Property Address': '1 Solo St',
      } as Record<string, string>,
    ]);
    expect(owners).toHaveLength(1);
  });
});
