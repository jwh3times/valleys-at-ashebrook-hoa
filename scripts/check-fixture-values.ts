/**
 * Fail the build on a phone number or email address that is not a reserved
 * synthetic value.
 *
 * This repository is public, and the roster it exists to protect holds real
 * residents' names, phone numbers, and email addresses. `SECURITY.md` promises
 * those live only in the D1 database — never in a committed file. A fixture
 * copied from real data is a realistic-looking fixture, and therefore a
 * tempting one by every measure except the one that matters, so the rule is
 * mechanical and CI-enforced: every phone number and every email address in
 * the tracked tree must be one that cannot belong to anyone.
 *
 *  - Phone numbers use the NANP fictional shapes: area code 555, exchange 555
 *    (`555-01XX` is the reserved block; the whole exchange counts because the
 *    tree already uses `555-0001`), or an exchange starting with 0 or 1, which
 *    NANP never assigns.
 *  - Email addresses use the RFC 2606 reserved names: `example.com`,
 *    `example.net`, `example.org`, or anything under the `.test`, `.example`,
 *    `.invalid`, or `.localhost` top-level domains.
 *  - A short allowlist below admits the published contact addresses and the
 *    hosts that appear in address shape without being anyone's mailbox
 *    (`git@github.com:` clone URLs, Google Calendar ids).
 *
 * SCOPE, stated honestly: this catches the *shape* of a phone number or an
 * email address. It cannot recognise a name or a street address, and it does
 * not know where a `555-01XX` number came from. It is a tripwire for one
 * specific mistake, not a proof that no personal data is committed — review
 * still has to ask where a fixture came from.
 *
 * Findings are reported as `file:line` plus the kind of value. The value
 * itself is never printed: CI logs on a public repository are public too.
 *
 * Usage:
 *
 *   node --experimental-strip-types scripts/check-fixture-values.ts
 *
 * Exits 1 listing every offending `file:line`. Add `fixture-ok` in a trailing
 * comment on the same line to allow a deliberate case, with a reason.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const ALLOW_MARKER = 'fixture-ok';

/** Never scanned. A prefix ends in `/`; anything else is an exact path. */
const SKIP_PATHS = [
  'design/', // static mockup kept as visual reference only; never edited
  'package-lock.json', // integrity hashes and registry URLs, no prose
];

const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);

/** Hosts that appear in address shape without being anyone's mailbox. */
const ALLOWED_DOMAINS = new Set([
  'github.com', // `git@github.com:owner/repo` clone URLs
  'group.calendar.google.com', // Google Calendar ids in .env.example and SETUP.md
  'holland.vip', // the maintainer's own domain (CODE_OF_CONDUCT.md, SUPPORT.md)
]);

/** Published contact addresses — public by design, so not fixtures. */
const ALLOWED_ADDRESSES = new Set([
  'jerryholland00@gmail.com', // maintainer contact in SECURITY.md and SUPPORT.md
  'valleysatashebrook@gmail.com', // the association's address, a form placeholder
]);

// A ten-digit NANP number in any common spelling: bare, dotted, dashed, spaced,
// parenthesised, with or without a leading `1` or `+1`. The lookarounds keep it
// off digit runs inside longer numbers, base64, and URLs.
const PHONE_RE =
  /(?<![\w/=+])(?:\+?1[ \t.-]?)?\(?([2-9]\d{2})\)?[ \t.-]?(\d{3})[ \t.-]?\d{4}(?![\w/=+])/g;

// An address with a dotted host and an alphabetic top-level domain, so a
// scoped package (`@astrojs/cloudflare`) or a version pin (`oxlint@1.79.0`)
// is not one.
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;

export type FindingKind = 'phone number' | 'email address';

export interface Finding {
  line: number;
  kind: FindingKind;
}

/** True when a NANP `area` + `exchange` pair cannot be a real subscriber. */
export function isSyntheticPhone(area: string, exchange: string): boolean {
  return (
    area === '555' ||
    exchange === '555' ||
    exchange.startsWith('0') ||
    exchange.startsWith('1')
  );
}

/** True when `address` is reserved, or published on purpose. */
export function isAllowedEmail(address: string): boolean {
  const lower = address.toLowerCase();
  if (ALLOWED_ADDRESSES.has(lower)) return true;
  const domain = lower.slice(lower.lastIndexOf('@') + 1);
  if (ALLOWED_DOMAINS.has(domain) || RESERVED_DOMAINS.has(domain)) return true;
  for (const reserved of RESERVED_DOMAINS) {
    if (domain.endsWith(`.${reserved}`)) return true;
  }
  return RESERVED_TLDS.has(domain.slice(domain.lastIndexOf('.') + 1));
}

/**
 * Every line of `source` holding a non-synthetic phone number or email
 * address, one finding per line and kind. Pure, so the rules are testable
 * without a tree to scan. The matched text is deliberately not returned.
 */
export function findContactValues(source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text.includes(ALLOW_MARKER)) continue;

    let phoneHit = false;
    for (const m of text.matchAll(PHONE_RE)) {
      if (!isSyntheticPhone(m[1], m[2])) phoneHit = true;
    }
    if (phoneHit) findings.push({ line: i + 1, kind: 'phone number' });

    let emailHit = false;
    for (const m of text.matchAll(EMAIL_RE)) {
      if (!isAllowedEmail(m[0])) emailHit = true;
    }
    if (emailHit) findings.push({ line: i + 1, kind: 'email address' });
  }

  return findings;
}

function isSkipped(file: string): boolean {
  return SKIP_PATHS.some((p) =>
    p.endsWith('/') ? file.startsWith(p) : file === p,
  );
}

/**
 * Tracked files plus untracked files git would not ignore — exactly what a
 * commit could publish. Ignored paths (`private/`, `.env`, `node_modules/`)
 * are outside the promise this gate enforces and may legitimately hold real
 * values.
 */
function listFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\0')
    .filter((f) => f !== '' && !isSkipped(f))
    .sort();
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function main(): void {
  const findings: { file: string; line: number; kind: FindingKind }[] = [];
  let scanned = 0;

  for (const file of listFiles()) {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(path.join(REPO_ROOT, file));
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (looksBinary(buffer)) continue;
    scanned += 1;
    for (const f of findContactValues(buffer.toString('utf8'))) {
      findings.push({ file, ...f });
    }
  }

  if (findings.length === 0) {
    console.log(
      `check-fixture-values: every phone number and email address is a reserved synthetic value (${scanned} files scanned).`,
    );
    return;
  }

  console.error(
    `check-fixture-values: found ${findings.length} contact value(s) that are not reserved synthetic values.\n` +
      `Phone numbers must use area code 555, exchange 555 (555-01XX preferred), or an exchange starting with 0 or 1.\n` +
      `Email addresses must use example.com/.net/.org or a .test, .example, .invalid, or .localhost name.\n` +
      `If a case is deliberate, add \`${ALLOW_MARKER}\` in a trailing comment with a reason.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.kind}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
