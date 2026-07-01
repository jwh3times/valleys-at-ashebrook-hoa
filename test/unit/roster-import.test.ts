import { describe, it, expect } from 'vitest';
import { rowsToOwners } from '../../scripts/import-roster';

describe('rowsToOwners', () => {
  it('maps spreadsheet rows to owner records with normalized addresses', () => {
    const out = rowsToOwners([
      {
        Name: 'Jane Doe',
        Address: '9904 Wishing Willow Dr.',
        Phone: '5551234567',
        Email: 'jane@x.com',
      },
    ]);
    expect(out[0]).toMatchObject({
      fullName: 'Jane Doe',
      address: '9904 Wishing Willow Dr.',
      addressNormalized: '9904 wishing willow dr',
      phone: '5551234567',
      email: 'jane@x.com',
      status: 'active',
    });
  });
});
