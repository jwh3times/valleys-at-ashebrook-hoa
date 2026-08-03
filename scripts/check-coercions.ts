/**
 * Fail the build on `Number(x) || <default>` and its `parseInt`/`parseFloat`
 * siblings, which silently rewrite a typed zero.
 *
 * `Number('')` and `Number('0')` are BOTH `0`, so the `||` cannot tell a blank
 * field from a real zero and substitutes the default. A board member who types
 * `0` gets the default instead of an error, and the server never sees the `0`
 * to reject it — the client-side default pre-empts the server's validation
 * rather than being redundant with it.
 *
 * This has bitten twice:
 *
 * - `Number(form) || 1` set a lot's `vote_weight` to 1 when the board typed 0.
 * - `Number(x) || 0` recorded a candidate's tally as a real zero when the field
 *   was left blank, destroying the NULL ("not recorded") vs 0 ("recorded as
 *   zero") distinction that `candidates.votes` is nullable to preserve.
 *
 * The fix is to check for blank BEFORE coercing:
 *
 *   const raw = form.field.trim();
 *   const value = raw === '' ? undefined : Number(raw);
 *
 * SCOPE, stated honestly: this catches the *shape*, not the *concept*. It flags
 * a coercion immediately defaulted with `||`. It cannot flag every way blank
 * might be conflated with zero. It is a tripwire for a specific recurrence, not
 * a proof of correctness — a review still has to think about the invariant.
 *
 * Usage:
 *
 *   node --experimental-strip-types scripts/check-coercions.ts
 *
 * Exits 1 listing every offending `file:line`. Add `coercion-ok` in a trailing
 * comment on the same line to allow a deliberate case, with a reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const SCAN_ROOT = path.join(REPO_ROOT, 'src');
const EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.js', '.jsx']);
const COERCERS = ['Number', 'parseInt', 'parseFloat'];
const ALLOW_MARKER = 'coercion-ok';

type Finding = { file: string; line: number; text: string };

/**
 * Blank out comment spans so the checker never flags a line that merely
 * *describes* the pattern. Both offending sites in this repo's history are now
 * documented in comments that quote the bad code verbatim, so this is load
 * bearing, not defensive. Characters are replaced with spaces rather than
 * removed, keeping every column index intact for reporting.
 */
function stripComments(source: string): string {
  const out = source.split('');
  let inBlock = false;
  let inLine = false;
  let quote: string | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (c === '\n') inLine = false;
      else out[i] = ' ';
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        inBlock = false;
      } else if (c !== '\n') {
        out[i] = ' ';
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      out[i] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 1;
    }
  }

  return out.join('');
}

/**
 * Find `<coercer>( ... ) ||` by walking balanced parentheses, so a nested call
 * like `Number(foo(bar)) || 1` is matched as reliably as a flat one. A regex
 * with `[^)]*` would stop at the first `)` and miss it.
 */
function findOffenders(source: string): number[] {
  const code = stripComments(source);
  const hits: number[] = [];

  for (const name of COERCERS) {
    const opener = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;

    while ((m = opener.exec(code)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < code.length && depth > 0) {
        if (code[i] === '(') depth += 1;
        else if (code[i] === ')') depth -= 1;
        i += 1;
      }
      if (depth !== 0) continue;
      // Only a default applied immediately to the coerced value is a problem;
      // `Number(x) === 0 || y` and similar are fine.
      if (/^\s*\|\|/.test(code.slice(i))) {
        hits.push(code.slice(0, m.index).split('\n').length);
      }
    }
  }

  return [...new Set(hits)].sort((a, b) => a - b);
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (EXTENSIONS.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

function main(): void {
  if (!fs.existsSync(SCAN_ROOT)) {
    console.error(`check-coercions: no ${SCAN_ROOT} to scan`);
    process.exit(1);
  }

  const findings: Finding[] = [];

  for (const file of walk(SCAN_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (const line of findOffenders(source)) {
      const text = lines[line - 1] ?? '';
      if (text.includes(ALLOW_MARKER)) continue;
      findings.push({
        file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
        line,
        text: text.trim(),
      });
    }
  }

  if (findings.length === 0) {
    console.log('check-coercions: no falsy-defaulted numeric coercions found.');
    return;
  }

  console.error(
    `check-coercions: found ${findings.length} numeric coercion(s) defaulted with \`||\`.\n` +
      `\`Number('')\` and \`Number('0')\` are both 0, so this silently rewrites a typed zero.\n` +
      `Check for blank before coercing:\n` +
      `  const raw = form.field.trim();\n` +
      `  const value = raw === '' ? undefined : Number(raw);\n` +
      `If a case is deliberate, add \`coercion-ok\` in a trailing comment with a reason.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  process.exit(1);
}

main();
