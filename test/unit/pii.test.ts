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
