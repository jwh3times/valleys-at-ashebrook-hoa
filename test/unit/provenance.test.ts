import { describe, it, expect } from 'vitest';
import { parseProvenance } from '../../src/server/content/proxy-guards';
import type { ProvenancePersonKey } from '../../src/server/content/proxy-guards';

// The same rule governs member attendance, member votes, and ballots; only
// the acting-Person column's name differs. Running the table over both names
// is the point — it is what the three hand-copied versions could not
// guarantee.
const KEYS: ProvenancePersonKey[] = ['castByPersonId', 'representedByPersonId'];

describe.each(KEYS)('parseProvenance (%s)', (personKey) => {
  it('accepts an entry naming neither', () => {
    const result = parseProvenance({ propertyId: 'p1' }, personKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: null, personId: null },
    });
  });

  it('accepts a proxy alone', () => {
    const result = parseProvenance({ proxyId: 'x1' }, personKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: 'x1', personId: null },
    });
  });

  it('accepts a person alone', () => {
    const result = parseProvenance({ [personKey]: 'o1' }, personKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: null, personId: 'o1' },
    });
  });

  it('rejects an entry carrying both — ADR 0018 mutual exclusion', () => {
    const result = parseProvenance(
      { proxyId: 'x1', [personKey]: 'o1' },
      personKey,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('cannot carry both');
    expect(result.error).toContain(personKey);
  });

  it('treats explicit nulls as absent, not as a conflict', () => {
    const result = parseProvenance(
      { proxyId: null, [personKey]: null },
      personKey,
    );
    expect(result).toEqual({
      ok: true,
      value: { proxyId: null, personId: null },
    });
  });

  it('rejects a non-string proxyId', () => {
    const result = parseProvenance({ proxyId: 42 }, personKey);
    expect(result).toEqual({
      ok: false,
      error: 'proxyId must be a string when present',
    });
  });

  it('rejects a non-string person id', () => {
    const result = parseProvenance({ [personKey]: 42 }, personKey);
    expect(result).toEqual({
      ok: false,
      error: `${personKey} must be a string when present`,
    });
  });

  it('reads nothing off a null record', () => {
    expect(parseProvenance(null, personKey)).toEqual({
      ok: true,
      value: { proxyId: null, personId: null },
    });
  });

  it('ignores the sibling person key', () => {
    const other: ProvenancePersonKey =
      personKey === 'castByPersonId' ? 'representedByPersonId' : 'castByPersonId';
    // A payload naming the OTHER route's column must not satisfy this one,
    // and must not trip the mutual exclusion either.
    const result = parseProvenance({ proxyId: 'x1', [other]: 'o1' }, personKey);
    expect(result).toEqual({
      ok: true,
      value: { proxyId: 'x1', personId: null },
    });
  });
});
