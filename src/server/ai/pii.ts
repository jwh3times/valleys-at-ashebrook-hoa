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

// --- Surrogate pools (deterministic; uniqueness comes from injective makers
// plus gen()'s collision checks against real values and issued surrogates) ---
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

// Common English words that also occur as name tokens. A roster name token
// equal to one of these is NOT registered as a standalone matcher, so ordinary
// document words ("green", "bill", "may") are not garbled. The full multi-token
// roster name still matches exactly, so the resident is masked when their whole
// name appears. Surnames that are proper nouns (e.g. "Smith") are intentionally
// absent — they stay maskable.
const COMMON_WORD_TOKENS = new Set([
  'bill',
  'green',
  'brown',
  'white',
  'black',
  'gray',
  'grey',
  'rose',
  'may',
  'june',
  'april',
  'august',
  'summer',
  'sunny',
  'young',
  'long',
  'short',
  'small',
  'major',
  'minor',
  'love',
  'joy',
  'hope',
  'faith',
  'grace',
  'honor',
  'noble',
  'stone',
  'wood',
  'woods',
  'hill',
  'moore',
  'moor',
  'fields',
  'banks',
  'brooks',
  'rivers',
  'forest',
  'baker',
  'cook',
  'mason',
  'carter',
  'page',
  'drew',
  'chase',
  'case',
  'reed',
  'read',
  'ford',
  'swift',
  'fox',
  'wolf',
  'bear',
  'lamb',
  'bird',
  'buck',
  'crane',
  'robin',
  'jay',
  'finch',
  'wren',
  'king',
  'knight',
  'earl',
  'duke',
  'will',
  'ray',
  'dean',
  'mark',
  'frank',
  'rich',
  'miles',
  'grant',
  'hunter',
  'walker',
  'turner',
  'fisher',
]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Generic catch-all for NON-roster phones. Requires either a parenthesized area
// code or at least one internal separator, and is digit-bounded, so a bare or
// longer numeric run (account/parcel/tracking IDs) is NOT masked as a phone.
// Roster phones are matched separately (compilePhoneRegex) in any format.
const PHONE_RE =
  /(?<!\d)(?:\+?1[\s./-]?)?(?:\(\d{3}\)[\s./-]?\d{3}[\s./-]?\d{4}|\d{3}[\s./-]\d{3}[\s./-]\d{4})(?!\d)/g;

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

// Matches a specific roster phone's 10 digits in any common format — bare,
// separated (space/./-/ /), or with a parenthesized area code and optional +1
// country code. Anchored to the exact digits (digit-bounded), so it cannot
// over-match a longer numeric run. Falls back to a literal matcher for values
// that are not 10 digits.
function compilePhoneRegex(value: string): RegExp {
  const d = normPhone(value);
  if (d.length !== 10) return compileDictRegex(value);
  const s = '[\\s./-]?';
  const area = `\\(?${d.slice(0, 3)}\\)?`;
  const mid = d.slice(3, 6);
  const line = d.slice(6, 10);
  return new RegExp(
    `(?<!\\d)(?:\\+?1${s})?${area}${s}${mid}${s}${line}(?!\\d)`,
    'g',
  );
}

// Every maker below is injective over ALL indexes: the base pool comes first,
// then deterministic disambiguation tiers (middle initial / apartment / phone
// extension / numeric tag). This is what guarantees gen() terminates — its
// skip-loop only ever discards a candidate for colliding with a finite set
// (roster values + already-issued surrogates), so never-repeating candidates
// must eventually clear it. With the old finite pools (16x14 = 224 names), a
// full roster exhausted the pool during pre-registration and gen() spun
// forever, hanging the Worker on every assistant request.
function makeName(i: number): string {
  const first = FIRST[i % FIRST.length];
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
  const tier = Math.floor(i / (FIRST.length * LAST.length));
  if (tier === 0) return `${first} ${last}`;
  // Tiers 1-26 add a middle initial (A. through Z.) — still natural-looking,
  // which matters because the model must echo surrogates back verbatim.
  if (tier <= 26) return `${first} ${String.fromCharCode(64 + tier)}. ${last}`;
  return `${first} ${last} ${tier - 26}`;
}
function makeAddress(i: number): string {
  const num = 100 + ((i * 37) % 800);
  const q = Math.floor(i / 800);
  const street = STREETS[q % STREETS.length];
  const suffix = SUFFIX[Math.floor(q / STREETS.length) % SUFFIX.length];
  const apt = Math.floor(q / (STREETS.length * SUFFIX.length));
  const base = `${num} ${street} ${suffix}`;
  return apt === 0 ? base : `${base} Apt ${apt}`;
}
function makePhone(i: number): string {
  // Area code 555 is unassigned in the NANP, so these numbers are structurally
  // undialable and can never digit-collide with a real roster phone.
  const line = String(1000 + ((i * 7) % 9000)).padStart(4, '0');
  const prefix = String(100 + (i % 100)).padStart(3, '0');
  const ext = Math.floor(i / 9000);
  const base = `(555) ${prefix}-${line}`;
  return ext === 0 ? base : `${base} x${ext}`;
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
  const realValues = new Set<string>(); // normalized real strings, to avoid look-alike surrogates
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

  // Name-pool word pairs that both appear in the SAME real roster name. The
  // exact-equality check below blocks only the base form, so without this the
  // disambiguation tiers would mint "Morgan A. Sutton" for a roster with a
  // real Morgan Sutton — a surrogate any reader identifies as that resident.
  // Tokens are lowercased with punctuation stripped and both orders stored,
  // so "Sutton, Morgan" and "Morgan J Sutton" block the pair too.
  const blockedPairs = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'name') continue;
    const tokens = normName(e.value)
      .split(' ')
      .map((t) => t.replace(/[^a-z]/g, ''))
      .filter((t) => t.length >= 2);
    for (const a of tokens)
      for (const b of tokens) if (a !== b) blockedPairs.add(`${a}|${b}`);
  }
  // Safety valve: pair-blocking must never leave gen() with zero eligible
  // name combinations — that would be the exhaustion hang all over again. If
  // a pathological roster blocks every FIRST x LAST pair, fall back to the
  // exact-value check alone.
  const pairBlockingActive = FIRST.some((f) =>
    LAST.some(
      (l) => !blockedPairs.has(`${f.toLowerCase()}|${l.toLowerCase()}`),
    ),
  );

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
    // an already-issued surrogate. Terminates because the makers are injective
    // over all indexes (see the maker comment above) while the collision set is
    // finite. The real-value check is case/whitespace-insensitive so an all-caps
    // roster entry still blocks its look-alike surrogate.
    for (;;) {
      const i = counts[type]++;
      if (type === 'name' && pairBlockingActive) {
        // Skip every tier of a (first, last) combination belonging to a real
        // resident. At least one combination is guaranteed unblocked (see the
        // safety valve above), and it recurs every 224 indexes across the
        // infinite tiers, so termination is preserved.
        const f = FIRST[i % FIRST.length].toLowerCase();
        const l =
          LAST[Math.floor(i / FIRST.length) % LAST.length].toLowerCase();
        if (blockedPairs.has(`${f}|${l}`)) continue;
      }
      const s =
        type === 'name'
          ? makeName(i)
          : type === 'address'
            ? makeAddress(i)
            : type === 'phone'
              ? makePhone(i)
              : makeEmail(i);
      if (!realValues.has(normName(s)) && !reverse.has(s)) return s;
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

  function addDictEntry(type: PiiType, value: string, re?: RegExp): void {
    const key = `${type}:${keyOf(type, value)}`;
    if (dictKeys.has(key)) return;
    dictKeys.add(key);
    dict.push({ type, value, re: re ?? compileDictRegex(value) });
  }

  // Pre-register roster entries so surrogates are stable and dictionary-driven.
  for (const e of entries) realValues.add(normName(e.value));
  for (const e of entries) {
    surrogateFor(e.type, e.value);
    if (e.type === 'name' || e.type === 'address') {
      addDictEntry(e.type, e.value);
    } else if (e.type === 'phone') {
      // Roster phones match in any format (incl. bare digits) via a flexible,
      // digit-anchored regex, so tightening the generic PHONE_RE above cannot
      // let a bare-digit roster phone leak.
      addDictEntry('phone', e.value, compilePhoneRegex(e.value));
    }
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
      if (COMMON_WORD_TOKENS.has(token.toLowerCase())) continue;
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

  function safeCutBefore(buffer: string, cut: number): number {
    // If a surrogate occurrence straddles `cut`, back up to its start so we never
    // emit a half surrogate. Surrogates are bounded by maxSurrogateLen.
    let best = cut;
    for (const sur of reverseByLen()) {
      let idx = 0;
      while ((idx = buffer.indexOf(sur, idx)) !== -1) {
        const end = idx + sur.length;
        if (idx < cut && end > cut && idx < best) best = idx;
        idx = end;
      }
    }
    return best;
  }

  function deanonymizeStream(): TransformStream<string, string> {
    let buffer = '';
    return new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk;
        // Read maxSurrogateLen live on every chunk — lazy minting during a
        // later anonymize() call can grow it after this stream was created,
        // and a stale hold could split that longer surrogate across emits.
        const hold = maxSurrogateLen;
        if (buffer.length <= hold) return;
        let cut = safeCutBefore(buffer, buffer.length - hold);
        if (cut > 0) {
          controller.enqueue(deanonymize(buffer.slice(0, cut)));
          buffer = buffer.slice(cut);
        }
      },
      flush(controller) {
        if (buffer) controller.enqueue(deanonymize(buffer));
      },
    });
  }

  return { anonymize, deanonymize, deanonymizeStream };
}
