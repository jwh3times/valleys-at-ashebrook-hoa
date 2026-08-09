import { describe, it, expect } from 'vitest';
import { parseProvenance } from '../../src/server/content/proxy-guards';
import type { ProvenanceOwnerKey } from '../../src/server/content/proxy-guards';

// The same rule governs member attendance, member votes, and ballots; only
// the owner column's name differs. Running the table over both names is the
// point — it is what the three hand-copied versions could not guarantee.
const KEYS: ProvenanceOwnerKey[] = ['castByOwnerId', 'representedByOwnerId'];

describe.each(KEYS)('parseProvenance (%s)', (ownerKey) => {
  it('accepts an entry naming neither', () => {
    const result = parseProvenance({ propertyId: 'p1' }, ownerKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: null, ownerId: null },
    });
  });

  it('accepts a proxy alone', () => {
    const result = parseProvenance({ proxyId: 'x1' }, ownerKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: 'x1', ownerId: null },
    });
  });

  it('accepts an owner alone', () => {
    const result = parseProvenance({ [ownerKey]: 'o1' }, ownerKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: null, ownerId: 'o1' },
    });
  });

  it('rejects an entry carrying both — ADR 0018 mutual exclusion', () => {
    const result = parseProvenance(
      { proxyId: 'x1', [ownerKey]: 'o1' },
      ownerKey,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('cannot carry both');
    expect(result.error).toContain(ownerKey);
  });

  it('treats explicit nulls as absent, not as a conflict', () => {
    const result = parseProvenance(
      { proxyId: null, [ownerKey]: null },
      ownerKey,
    );
    expect(result).toEqual({
      ok: true,
      value: { proxyId: null, ownerId: null },
    });
  });

  it('rejects a non-string proxyId', () => {
    const result = parseProvenance({ proxyId: 42 }, ownerKey);
    expect(result).toEqual({
      ok: false,
      error: 'proxyId must be a string when present',
    });
  });

  it('rejects a non-string owner id', () => {
    const result = parseProvenance({ [ownerKey]: 42 }, ownerKey);
    expect(result).toEqual({
      ok: false,
      error: `${ownerKey} must be a string when present`,
    });
  });

  it('reads nothing off a null record', () => {
    expect(parseProvenance(null, ownerKey)).toEqual({
      ok: true,
      value: { proxyId: null, ownerId: null },
    });
  });

  it('ignores the sibling owner key', () => {
    const other: ProvenanceOwnerKey =
      ownerKey === 'castByOwnerId' ? 'representedByOwnerId' : 'castByOwnerId';
    // A payload naming the OTHER route's column must not satisfy this one,
    // and must not trip the mutual exclusion either.
    const result = parseProvenance({ proxyId: 'x1', [other]: 'o1' }, ownerKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: 'x1', ownerId: null },
    });
  });
});
