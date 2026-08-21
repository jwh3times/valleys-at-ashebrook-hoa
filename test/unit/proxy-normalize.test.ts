import { describe, it, expect } from 'vitest';
import { normalizeProxyInput } from '../../src/lib/types';

const base = {
  propertyId: 'p1',
  grantorPersonId: 'o1',
  holderName: 'Jane Q. Holder',
  meetingId: 'm1',
};

describe('normalizeProxyInput', () => {
  it('accepts a meeting-scoped create and trims holderName', () => {
    const r = normalizeProxyInput(
      { ...base, holderName: '  Jane  ' },
      'create',
    );
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: 'p1',
        grantorPersonId: 'o1',
        holderName: 'Jane',
        meetingId: 'm1',
      },
    });
  });

  it('rejects a create with neither occasion', () => {
    const r = normalizeProxyInput(
      { propertyId: 'p1', grantorPersonId: 'o1', holderName: 'J' },
      'create',
    );
    expect(r).toEqual({
      ok: false,
      error: 'Exactly one of meetingId or electionId is required',
    });
  });

  it('rejects a create with both occasions', () => {
    const r = normalizeProxyInput({ ...base, electionId: 'e1' }, 'create');
    expect(r).toEqual({
      ok: false,
      error: 'Exactly one of meetingId or electionId is required',
    });
  });

  it('rejects patch payloads carrying scope or propertyId on key presence', () => {
    for (const key of ['meetingId', 'electionId', 'propertyId']) {
      const r = normalizeProxyInput({ [key]: 'x1' }, 'patch');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('not editable');
    }
    // Even null/undefined values are rejected — presence is the offence.
    expect(normalizeProxyInput({ meetingId: null }, 'patch').ok).toBe(false);
  });

  it('rejects grantorPersonId === holderPersonId', () => {
    const r = normalizeProxyInput({ ...base, holderPersonId: 'o1' }, 'create');
    expect(r).toEqual({
      ok: false,
      error: 'grantorPersonId and holderPersonId cannot be the same person',
    });
  });

  it('requires propertyId, grantorPersonId, and holderName on create', () => {
    for (const key of ['propertyId', 'grantorPersonId', 'holderName']) {
      const { [key]: _omitted, ...rest } = base as Record<string, unknown>;
      const r = normalizeProxyInput(rest, 'create');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(key);
    }
  });

  it('allows a patch editing only holder fields', () => {
    const r = normalizeProxyInput(
      { holderName: 'New Holder', holderPersonId: null },
      'patch',
    );
    expect(r).toEqual({
      ok: true,
      value: { holderName: 'New Holder', holderPersonId: null },
    });
  });
});
