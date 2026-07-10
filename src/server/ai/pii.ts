// Reversible PII pseudonymization for the admin document assistant.
//
// Real resident PII (from the roster) and any email/phone anywhere are swapped
// for realistic, consistent, reversible surrogates BEFORE text reaches Anthropic,
// and mapped back on the way out. Privacy depends on `anonymize` completeness;
// `deanonymize` is best-effort/cosmetic (see the design spec §4.4).

export type PiiType = 'name' | 'address' | 'phone' | 'email';
export interface PiiEntry {
  type: PiiType;
  value: string;
}

export interface Pseudonymizer {
  anonymize(text: string): string;
  deanonymize(text: string): string;
  deanonymizeStream(): TransformStream<string, string>;
}

// --- Surrogate pools (deterministic, collision-free by construction) ---
const FIRST = [
  'Avery',
  'Blake',
  'Casey',
  'Devon',
  'Emerson',
  'Finley',
  'Harper',
  'Jordan',
  'Kendall',
  'Logan',
  'Morgan',
  'Parker',
  'Quinn',
  'Reese',
  'Sawyer',
  'Taylor',
];
const LAST = [
  'Ashfield',
  'Brookmere',
  'Calder',
  'Dunmore',
  'Ellery',
  'Fenwick',
  'Granger',
  'Holloway',
  'Ives',
  'Larkin',
  'Merrow',
  'Presley',
  'Rowan',
  'Sutton',
];
const STREETS = [
  'Maple',
  'Cedar',
  'Birch',
  'Willow',
  'Juniper',
  'Aspen',
  'Sycamore',
  'Poplar',
  'Hawthorn',
  'Linden',
  'Chestnut',
  'Magnolia',
];
const SUFFIX = ['Street', 'Avenue', 'Court', 'Drive', 'Lane', 'Way'];
const EMAIL_DOMAIN = 'example.org'; // reserved; never a real address

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// NANP-style: optional +1, area code (parens optional), separators optional.
// Separators allow whitespace, '.', '/', or '-' (e.g. "919/555/0100").
const PHONE_RE =
  /(?:\+?1[\s./-]?)?(?:\(\d{3}\)|\d{3})[\s./-]?\d{3}[\s./-]?\d{4}/g;

function normName(v: string): string {
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}
function normPhone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-bounded, whitespace-flexible literal matcher: tolerates irregular
// internal spacing (e.g. double spaces) and prevents substring corruption
// (e.g. a roster name "Lane" matching inside "airplane"). Uses non-word
// lookarounds rather than `\b` so a value whose own edge is a non-word
// character (e.g. an address ending in "St.") still matches — `\b` requires
// the matched text's edge to be a word character, so it fails (and the real
// value leaks) whenever a roster value is followed/preceded by punctuation.
// `(?<!\w)`/`(?!\w)` still block gluing onto a surrounding word (so "Lane"
// still won't match inside "airplane"), without constraining the value's own
// edge character.
function compileDictRegex(value: string): RegExp {
  const pattern = escapeRegExp(value).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<!\\w)${pattern}(?!\\w)`, 'gi');
}

function makeName(i: number): string {
  return `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
}
function makeAddress(i: number): string {
  const num = 100 + ((i * 37) % 800);
  return `${num} ${STREETS[i % STREETS.length]} ${SUFFIX[Math.floor(i / STREETS.length) % SUFFIX.length]}`;
}
function makePhone(i: number): string {
  // 555-01xx line-number range is reserved for fictional use.
  const line = String(1000 + ((i * 7) % 9000)).padStart(4, '0');
  const prefix = String(100 + (i % 100)).padStart(3, '0');
  return `(555) ${prefix}-${line}`;
}
function makeEmail(i: number): string {
  const f = FIRST[i % FIRST.length].toLowerCase();
  const l = LAST[Math.floor(i / FIRST.length) % LAST.length].toLowerCase();
  return `${f}.${l}${i}@${EMAIL_DOMAIN}`;
}

interface Span {
  start: number;
  end: number;
  replacement: string;
  len: number;
}

function applySpans(text: string, spans: Span[]): string {
  // Non-overlapping, longest-first: sort by start asc then length desc, then
  // greedily keep spans that don't overlap a chosen one; splice right-to-left.
  spans.sort((a, b) => a.start - b.start || b.len - a.len);
  const chosen: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      chosen.push(s);
      lastEnd = s.end;
    }
  }
  let out = text;
  for (let i = chosen.length - 1; i >= 0; i--) {
    const s = chosen[i];
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  }
  return out;
}

export function buildPseudonymizer(entries: PiiEntry[]): Pseudonymizer {
  const forward = new Map<string, string>(); // `${type}:${norm}` -> surrogate
  const reverse = new Map<string, string>(); // surrogate -> real
  const realValues = new Set<string>(); // exact real strings, to avoid collisions
  const counts: Record<PiiType, number> = {
    name: 0,
    address: 0,
    phone: 0,
    email: 0,
  };
  // Dictionary of known literal strings to match (names + addresses), longest
  // first, each with its regex compiled once up front (not per anonymize call).
  const dict: { type: PiiType; value: string; re: RegExp }[] = [];
  const dictKeys = new Set<string>(); // dedup: a token or value registered at most once
  let maxSurrogateLen = 1;

  function keyOf(type: PiiType, value: string): string {
    const n =
      type === 'phone'
        ? normPhone(value)
        : type === 'email'
          ? value.toLowerCase()
          : normName(value);
    return `${type}:${n}`;
  }

  function gen(type: PiiType): string {
    // Bump the index until the surrogate collides with neither a real value nor
    // an already-issued surrogate.
    for (;;) {
      const i = counts[type]++;
      const s =
        type === 'name'
          ? makeName(i)
          : type === 'address'
            ? makeAddress(i)
            : type === 'phone'
              ? makePhone(i)
              : makeEmail(i);
      if (!realValues.has(s) && !reverse.has(s)) return s;
    }
  }

  function surrogateFor(type: PiiType, real: string): string {
    const k = keyOf(type, real);
    let s = forward.get(k);
    if (!s) {
      s = gen(type);
      forward.set(k, s);
      reverse.set(s, real);
      if (s.length > maxSurrogateLen) maxSurrogateLen = s.length;
    }
    return s;
  }

  function addDictEntry(type: PiiType, value: string): void {
    const key = `${type}:${normName(value)}`;
    if (dictKeys.has(key)) return;
    dictKeys.add(key);
    dict.push({ type, value, re: compileDictRegex(value) });
  }

  // Pre-register roster entries so surrogates are stable and dictionary-driven.
  for (const e of entries) realValues.add(e.value);
  for (const e of entries) {
    surrogateFor(e.type, e.value);
    if (e.type === 'name' || e.type === 'address')
      addDictEntry(e.type, e.value);
  }
  // Also register individual name tokens (e.g. "Marie" from "Anne Marie") as
  // lower-priority matchers. These catch the residual real-name fragment left
  // behind when two roster names share a token and their spans cross (the
  // greedy non-overlap selection in applySpans drops the crossing span
  // entirely, leaving its non-overlapping tail unscrubbed). Single-letter
  // tokens (middle initials) are skipped. Addresses are NOT tokenized —
  // street words like "Lane" or "Court" are too common to scrub safely, and
  // address crossing-overlaps are not a concern here.
  for (const e of entries) {
    if (e.type !== 'name') continue;
    for (const token of e.value.split(/\s+/)) {
      if (token.length < 2) continue;
      addDictEntry('name', token);
    }
  }
  // Longest literals first so an address or full name wins over a shorter
  // token/substring match.
  dict.sort((a, b) => b.value.length - a.value.length);

  function anonymize(text: string): string {
    const spans: Span[] = [];
    for (const m of text.matchAll(EMAIL_RE)) {
      const real = m[0];
      spans.push({
        start: m.index!,
        end: m.index! + real.length,
        len: real.length,
        replacement: surrogateFor('email', real),
      });
    }
    for (const m of text.matchAll(PHONE_RE)) {
      const real = m[0];
      if (normPhone(real).length !== 10) continue;
      spans.push({
        start: m.index!,
        end: m.index! + real.length,
        len: real.length,
        replacement: surrogateFor('phone', real),
      });
    }
    for (const { type, value, re } of dict) {
      // `matchAll` clones the regex internally, so reusing this precompiled,
      // stateful-looking `g` regex across calls/entries is safe.
      for (const m of text.matchAll(re)) {
        const matched = m[0];
        spans.push({
          start: m.index!,
          end: m.index! + matched.length,
          len: matched.length,
          replacement: surrogateFor(type, value),
        });
      }
    }
    return applySpans(text, spans);
  }

  const reverseByLen = () =>
    [...reverse.keys()].sort((a, b) => b.length - a.length);

  function deanonymize(text: string): string {
    const spans: Span[] = [];
    for (const sur of reverseByLen()) {
      const real = reverse.get(sur)!;
      let idx = 0;
      while ((idx = text.indexOf(sur, idx)) !== -1) {
        spans.push({
          start: idx,
          end: idx + sur.length,
          len: sur.length,
          replacement: real,
        });
        idx += sur.length;
      }
    }
    return applySpans(text, spans);
  }

  function deanonymizeStream(): TransformStream<string, string> {
    // Implemented in Task 3.
    throw new Error('deanonymizeStream not implemented');
  }

  return { anonymize, deanonymize, deanonymizeStream };
}
