import { describe, it, expect } from 'vitest';
import {
  INPUT_LIMITS,
  normalizeAnnouncementInput,
  normalizePropertyInput,
  normalizeOwnerInput,
} from '../../src/lib/types';

describe('normalizeAnnouncementInput', () => {
  it('trims strings and drops unknown keys on create', () => {
    const r = normalizeAnnouncementInput(
      {
        title: '  Notice  ',
        body: '  Hello  ',
        date: '2026-02-02',
        pinned: true,
        visibility: 'homeowner',
        evil: 'x',
        id: 'should-be-ignored',
      },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      title: 'Notice',
      body: 'Hello',
      date: '2026-02-02',
      pinned: true,
      visibility: 'homeowner',
    });
    expect('evil' in r.value).toBe(false);
    expect('id' in r.value).toBe(false);
  });

  it('rejects a missing required field on create', () => {
    const r = normalizeAnnouncementInput(
      { body: 'x', date: '2026-02-02' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/title/i);
  });

  it('rejects a whitespace-only required field on create', () => {
    const r = normalizeAnnouncementInput(
      { title: '   ', body: 'x', date: '2026-02-02' },
      'create',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an over-length body', () => {
    const r = normalizeAnnouncementInput(
      {
        title: 'T',
        body: 'x'.repeat(INPUT_LIMITS.body + 1),
        date: '2026-02-02',
      },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/body/i);
  });

  it('rejects an invalid visibility enum', () => {
    const r = normalizeAnnouncementInput(
      { title: 'T', body: 'B', date: '2026-02-02', visibility: 'admin' },
      'create',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed date', () => {
    const r = normalizeAnnouncementInput(
      { title: 'T', body: 'B', date: '2026-13-40' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/date/i);
  });

  it('allows a partial patch with only present fields', () => {
    const r = normalizeAnnouncementInput({ title: 'New title' }, 'patch');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ title: 'New title' });
  });

  it('rejects a present-but-empty required field even in patch mode', () => {
    const r = normalizeAnnouncementInput({ title: '  ' }, 'patch');
    expect(r.ok).toBe(false);
  });
});

describe('normalizePropertyInput', () => {
  it('requires address on create and maps empty nullable fields to null', () => {
    const r = normalizePropertyInput(
      { address: ' 12 Oak St ', unit: '', notes: '  ' },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.address).toBe('12 Oak St');
    expect(r.value.unit).toBeNull();
    expect(r.value.notes).toBeNull();
  });

  it('rejects a missing address on create', () => {
    const r = normalizePropertyInput({ unit: 'A' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid status', () => {
    const r = normalizePropertyInput({ id: 'x', status: 'archived' }, 'patch');
    expect(r.ok).toBe(false);
  });

  it('rejects an over-length address', () => {
    const r = normalizePropertyInput(
      { address: 'x'.repeat(INPUT_LIMITS.address + 1) },
      'create',
    );
    expect(r.ok).toBe(false);
  });
});

describe('normalizeOwnerInput', () => {
  it('requires propertyId and fullName on create', () => {
    const r = normalizeOwnerInput({ fullName: 'Jane' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('trims fields and maps empty email/phone to null', () => {
    const r = normalizeOwnerInput(
      { propertyId: 'p1', fullName: '  Jane Doe  ', email: '', phone: '' },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fullName).toBe('Jane Doe');
    expect(r.value.email).toBeNull();
    expect(r.value.phone).toBeNull();
  });

  it('rejects an over-length email', () => {
    const r = normalizeOwnerInput(
      {
        propertyId: 'p1',
        fullName: 'J',
        email: 'x'.repeat(INPUT_LIMITS.email + 1),
      },
      'create',
    );
    expect(r.ok).toBe(false);
  });
});
