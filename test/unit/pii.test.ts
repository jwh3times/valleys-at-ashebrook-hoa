import { describe, it, expect } from 'vitest';
import { buildPseudonymizer, type PiiEntry } from '../../src/server/ai/pii';

const ROSTER: PiiEntry[] = [
  { type: 'name', value: 'Jane Q Homeowner' },
  { type: 'name', value: 'Bob Neighbor' },
  { type: 'address', value: '123 Ashebrook Lane' },
  { type: 'phone', value: '(919) 555-0100' },
  { type: 'email', value: 'jane@realmail.com' },
];

describe('pseudonymizer — anonymize', () => {
  it('replaces every roster name/address/phone/email in the text', () => {
    const p = buildPseudonymizer(ROSTER);
    const text =
      'Jane Q Homeowner at 123 Ashebrook Lane, call (919) 555-0100 or jane@realmail.com. Bob Neighbor too.';
    const out = p.anonymize(text);
    for (const e of ROSTER) expect(out).not.toContain(e.value);
    // A phone/email that is NOT in the roster still gets scrubbed by regex.
    const out2 = p.anonymize('Reach vendor at vendor@acme.co or 704-555-0199.');
    expect(out2).not.toContain('vendor@acme.co');
    expect(out2).not.toContain('704-555-0199');
  });

  it('is consistent — the same real value maps to the same surrogate', () => {
    const p = buildPseudonymizer(ROSTER);
    const a = p.anonymize('Jane Q Homeowner');
    const b = p.anonymize('Contact Jane Q Homeowner today.');
    expect(b).toContain(a.trim());
  });

  it('round-trips: deanonymize(anonymize(text)) restores the original', () => {
    const p = buildPseudonymizer(ROSTER);
    const text = 'Jane Q Homeowner lives at 123 Ashebrook Lane.';
    expect(p.deanonymize(p.anonymize(text))).toBe(text);
  });

  it('does not corrupt overlapping matches (single-pass, longest-first)', () => {
    // A name that is a substring of an address-like phrase must not double-replace.
    const p = buildPseudonymizer([
      { type: 'name', value: 'Ashebrook' },
      { type: 'address', value: '123 Ashebrook Lane' },
    ]);
    const out = p.anonymize('Mail to 123 Ashebrook Lane please.');
    expect(out).not.toContain('123 Ashebrook Lane');
    // The longer address match wins; the standalone "Ashebrook" surrogate is not
    // spliced inside the address replacement.
    expect(p.deanonymize(out)).toBe('Mail to 123 Ashebrook Lane please.');
  });

  it('never emits a surrogate equal to a real roster value', () => {
    const p = buildPseudonymizer(ROSTER);
    const out = p.anonymize('Jane Q Homeowner and Bob Neighbor');
    // Surrogates come from disjoint pools / reserved ranges; assert no real leaks.
    expect(out).not.toContain('Jane Q Homeowner');
    expect(out).not.toContain('Bob Neighbor');
  });
});

describe('pseudonymizer — hardening', () => {
  it('does not leak a real name fragment from a crossing overlap between two roster names', () => {
    const p = buildPseudonymizer([
      { type: 'name', value: 'Anne Marie' },
      { type: 'name', value: 'Marie Smith' },
    ]);
    const text = 'Anne Marie Smith';
    const out = p.anonymize(text);
    expect(out).not.toContain('Smith');
    expect(out).not.toContain('Marie');
    expect(out).not.toContain('Anne');
    expect(out).not.toContain('Anne Marie');
    expect(out).not.toContain('Marie Smith');
    expect(p.deanonymize(p.anonymize(text))).toBe(text);
  });

  it('scrubs a slash-separated phone number', () => {
    const p = buildPseudonymizer([]);
    const out = p.anonymize('call 919/555/0100 today');
    expect(out).not.toContain('919/555/0100');
  });

  it('matches a dictionary address across irregular internal spacing', () => {
    const p = buildPseudonymizer([
      { type: 'address', value: '123 Ashebrook Lane' },
    ]);
    const out = p.anonymize('Mail to 123  Ashebrook  Lane please');
    expect(out).not.toContain('Ashebrook');
  });

  it('applies word boundaries so a dictionary name cannot corrupt a longer word', () => {
    const p = buildPseudonymizer([{ type: 'name', value: 'Lane' }]);
    const airplane = p.anonymize('The airplane landed');
    expect(airplane).toContain('airplane');
    const standalone = p.anonymize('Call Lane now');
    expect(standalone).not.toMatch(/\bLane\b/);
  });

  it('matches a roster address ending in a period even though it is not a word character', () => {
    const p = buildPseudonymizer([{ type: 'address', value: '123 Main St.' }]);
    const text = 'Mail to 123 Main St. today';
    const out = p.anonymize(text);
    expect(out).not.toContain('123 Main St.');
    expect(p.deanonymize(p.anonymize(text))).toBe(text);
  });
});

describe('pseudonymizer — surrogate pool exhaustion (roster-scale)', () => {
  const names = (n: number): PiiEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      type: 'name' as const,
      value: `Resident${i} Household${i}`,
    }));

  it('construction terminates and round-trips past the 224-combination base name pool', () => {
    // 300 full names (plus their per-token surrogates) exceed the 16x14 base
    // pool several times over; the old generator looped forever once it ran dry.
    const p = buildPseudonymizer(names(300));
    const text =
      'Resident0 Household0, Resident150 Household150, Resident299 Household299';
    const out = p.anonymize(text);
    expect(out).not.toMatch(/Resident\d|Household\d/);
    expect(p.deanonymize(out)).toBe(text);
  });

  it('name surrogates stay collision-free deep into the disambiguated tiers', () => {
    // 6100 pre-registered names push generation past the base pool AND the
    // middle-initial tier (224 + 224*26 = 6048) into the numeric tail.
    const p = buildPseudonymizer(names(6100));
    const text =
      'Resident1 Household1 met Resident3000 Household3000 and Resident6099 Household6099.';
    const out = p.anonymize(text);
    expect(out).not.toMatch(/Resident\d|Household\d/);
    expect(p.deanonymize(out)).toBe(text);
  });

  it('never issues a surrogate that case-insensitively equals a real roster value', () => {
    // "Morgan Sutton" is a base-pool combination. A resident stored in a
    // different case must still block it from being issued as a surrogate.
    const roster: PiiEntry[] = [
      { type: 'name', value: 'MORGAN SUTTON' },
      ...names(230),
    ];
    const p = buildPseudonymizer(roster);
    const text = 'Attendees: MORGAN SUTTON, Resident100 Household100';
    const out = p.anonymize(text);
    expect(out.toLowerCase()).not.toContain('morgan sutton');
    expect(p.deanonymize(out)).toBe(text);
  });

  it("never issues a tiered surrogate reusing a real resident's first+last pair", () => {
    // A real "Morgan Sutton" blocks the base surrogate via the equality check,
    // but the disambiguation tiers must be blocked too — "Morgan A. Sutton"
    // still reads as the real resident. Tier minting starts past 224 issued
    // surrogates, so pad the roster well beyond it.
    const roster: PiiEntry[] = [
      { type: 'name', value: 'Morgan Sutton' },
      ...names(460),
    ];
    const p = buildPseudonymizer(roster);
    const text = roster.map((e) => e.value).join(', ');
    const out = p.anonymize(text);
    expect(out).not.toMatch(/morgan(?:\s+\w+\.?)?\s+sutton/i);
    expect(p.deanonymize(out)).toBe(text);
  });

  it('address and phone generation survive their base-pool sizes', () => {
    const roster: PiiEntry[] = [
      ...Array.from({ length: 7300 }, (_, i) => ({
        type: 'address' as const,
        value: `${1000 + i} Ashwood Circle Unit ${i}`,
      })),
      ...Array.from({ length: 9100 }, (_, i) => ({
        type: 'phone' as const,
        value: String(9190000000 + i),
      })),
    ];
    const p = buildPseudonymizer(roster);
    const text = 'Deed for 8299 Ashwood Circle Unit 7299, call 9190009099.';
    const out = p.anonymize(text);
    expect(out).not.toContain('Ashwood');
    expect(out).not.toContain('9190009099');
    expect(p.deanonymize(out)).toBe(text);
  });
});

describe('pseudonymizer — deanonymizeStream', () => {
  it('reassembles a surrogate split across two chunks', async () => {
    const p = buildPseudonymizer([{ type: 'name', value: 'Jane Q Homeowner' }]);
    const sur = p.anonymize('Jane Q Homeowner').trim(); // e.g. "Avery Ashfield"
    const cut = Math.ceil(sur.length / 2);
    const parts = [`Owner is ${sur.slice(0, cut)}`, `${sur.slice(cut)} today.`];

    const out: string[] = [];
    const rs = new ReadableStream<string>({
      start(c) {
        for (const part of parts) c.enqueue(part);
        c.close();
      },
    });
    const reader = rs.pipeThrough(p.deanonymizeStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out.join('')).toBe('Owner is Jane Q Homeowner today.');
  });
});
