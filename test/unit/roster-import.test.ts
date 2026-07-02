import { describe, it, expect } from 'vitest';
import {
  rowsToRoster,
  firstEmail,
  firstPhoneE164,
} from '../../scripts/import-roster';

describe('firstPhoneE164', () => {
  it('takes the first number from a labeled, multi-number cell as E.164', () => {
    expect(firstPhoneE164('John (919) 451-7647, Ginny (919) 816-5442')).toBe(
      '+19194517647',
    );
    expect(
      firstPhoneE164('Cell Phone: (919) 697-0594,  Home Phone: (919) 291-3651'),
    ).toBe('+19196970594');
    expect(firstPhoneE164('919.451.7647')).toBe('+19194517647');
  });

  it('returns null when there is no usable phone', () => {
    expect(firstPhoneE164('')).toBeNull();
    expect(firstPhoneE164(undefined)).toBeNull();
    expect(firstPhoneE164('n/a')).toBeNull();
  });
});

describe('firstEmail', () => {
  it('takes the first address from a multi-email cell', () => {
    expect(firstEmail('johnjordan108@mail.com, gjordan1002@gmail.com')).toBe(
      'johnjordan108@mail.com',
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
        'Homeowner 1': 'John Jordan',
        'Homeowner 1 Phone': '(919) 451-7647',
        'Homeowner 1 Email': 'johnjordan108@mail.com',
        'Property Address': '3032 Cinder Bluff Drive Raleigh, NC  27603',
        'Unit No': '',
      } as Record<string, string>,
    ]);
    expect(properties).toHaveLength(1);
    expect(properties[0].addressNormalized).toBe(
      '3032 cinder bluff drive raleigh nc 27603',
    );
    expect(properties[0].unit).toBeNull();
    expect(owners).toHaveLength(1);
    expect(owners[0].propertyId).toBe(properties[0].id);
    expect(owners[0].fullName).toBe('John Jordan');
    expect(owners[0].phone).toBe('+19194517647');
    expect(owners[0].email).toBe('johnjordan108@mail.com');
  });
});
