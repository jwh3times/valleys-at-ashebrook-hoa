import { describe, expect, it } from 'vitest';
import { invitationNextQuery } from '../../src/lib/return-path';

const TOKEN = 'a'.repeat(43);

describe('invitationNextQuery', () => {
  it('carries a valid invitation link forward as an encoded next', () => {
    const next = encodeURIComponent(`/tenant-invite?token=${TOKEN}`);
    expect(invitationNextQuery(`?next=${next}`)).toBe(`?next=${next}`);
  });

  it('is empty when there is no next', () => {
    expect(invitationNextQuery('')).toBe('');
  });

  it('is empty when next is anything but an invitation link', () => {
    expect(
      invitationNextQuery(
        `?next=${encodeURIComponent('https://evil.example')}`,
      ),
    ).toBe('');
  });
});
