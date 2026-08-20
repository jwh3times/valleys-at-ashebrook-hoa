import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The ballot-secrecy boundary (#204's "Ballot secrecy boundary", #220's
// acceptance criterion, ADR 0017 and ADR 0020).
//
// The rule, in #204's words: no Audit Event, Review Flag, correlation, export,
// or log produced by phase 3d may reference `ballot_choices` or candidate
// selection. Flags reach the identity-linked turnout `ballots` row and the
// election occasion, and stop there.
//
// This is the STATIC half of the two-layer suite #206 says outlives the
// migration; `test/server/ballot-privacy.test.ts` is the runtime half, and
// `verify:invariants`' `no_flag_references_ballot_choices` is the third leg.
// A static scan earns its place here because the failure this guards against
// is a future edit, not a present bug: impact discovery is exactly the feature
// that would find joining choices to owners convenient, and the join would
// look perfectly reasonable in review. The scan makes writing it fail a test.
//
// Modelled on `adr0022-model-boundary.test.ts`: an explicit allow-list where
// every entry earns its place, and a hard deny-list for the machinery that
// must stay clean forever.
//
// Scope is `src/` only. Test files legitimately read `ballot_choices` — that
// is how the runtime suite and `transfer-effects.test.ts` prove the rows are
// byte-identical across a transfer — and `src/server/db/migrations/**` is
// `.sql`/`.json`, which the source-file walk below does not match anyway (the
// table has to be CREATEd somewhere).

const SRC = join(process.cwd(), 'src');

/** The choice table, in both its SQL and its Drizzle spelling. */
const CHOICE_TERMS = ['ballot_choices', 'ballotChoices'];

/** Candidate selection is protected identically: WHICH candidate a lot chose
 * is the secret, so a column naming one is as disclosing as a choice row. */
const CANDIDATE_TERMS = ['candidate_id', 'candidateId'];

/**
 * Modules that may name the choice table IN CODE. Three, and each is a
 * pre-existing voting or tally surface that cannot do its job without it.
 */
const CHOICE_CODE_ALLOWED = new Map([
  [
    'server/db/schema.ts',
    'the `ballot_choices` table definition itself (ADR 0020) — deliberately ' +
      'carrying no ballot, property, owner, proxy, caster, or timestamp column',
  ],
  [
    'server/content/voting.ts',
    'the cast path: the one legitimate writer, inserting the identity-unlinked ' +
      'choice rows in the same checked batch as the turnout row',
  ],
  [
    'pages/api/admin/elections.ts',
    "conducted close derives each candidate's final tally as SUM over the " +
      'retained choice rows; no tally is exposed while the election is open',
  ],
]);

/**
 * Modules that name the choice table only in PROSE — the two places that
 * DECLARE the rule. Stating the prohibition where a future reader will meet it
 * is the point, so they are allowed the mention and separately pinned to
 * comments only by the test below.
 */
const CHOICE_PROSE_ONLY = new Map([
  [
    'server/roster/transfer-effects.ts',
    "the module header's BALLOT SECRECY note, declaring what the discovery " +
      'engine does not do',
  ],
  [
    'server/db/audit-schema.ts',
    "the `review_flags` header comment, declaring a flag's reach: the turnout " +
      'Ballot and the occasion, and nothing else',
  ],
]);

/**
 * Modules that NAME the choice table without ever querying it. One: the
 * invariant gate, whose `no_flag_references_ballot_choices` check is the third
 * leg named in this file's header. It spells the table in a check name and an
 * operator-facing meaning string — code, not prose, so the prose-only
 * exemption above does not fit — while its SQL asks
 * `pragma_table_info('review_flags')` about column NAMES and never reads a row.
 *
 * It arrived under this scan when #240 moved the check list out of
 * `scripts/verify-invariants.ts` into `src/` to share it with the Worker's
 * scheduled run. A blanket allow-list entry would be the widest hole in the
 * file, so the mention is allowed and the query is separately denied below.
 */
const CHOICE_NAMED_NOT_QUERIED = new Map([
  [
    'server/db/invariants.ts',
    "the `no_flag_references_ballot_choices` check's name and meaning; its " +
      'SQL inspects review_flags column names and reads no choice row',
  ],
]);

/**
 * The phase 3d machinery. These files produce every event, flag, and export
 * a transfer creates, and must stay clean forever — this is the deny-list the
 * whole file exists for.
 */
const MACHINERY = [
  'server/roster/transfer-effects.ts',
  'pages/api/admin/review-flags.ts',
  'server/roster/audit.ts',
  'server/roster/reads.ts',
  'pages/api/admin/roster-export.ts',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

const relativePath = (file: string) =>
  relative(SRC, file).split('\\').join('/');

const read = (rel: string) =>
  readFileSync(join(SRC, ...rel.split('/')), 'utf8');

/**
 * Source with comments removed, so "this module does not touch X" can be
 * written down without the sentence itself tripping the scan.
 *
 * URLs are neutralised first: `https://…` in a doc link would otherwise read
 * as a line comment and swallow the rest of that line, which could HIDE a real
 * reference rather than merely over-report one.
 */
function stripComments(source: string): string {
  return source
    .replace(/https?:\/\//g, 'url_')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '');
}

describe('the ballot-secrecy boundary', () => {
  it('confines every ballot-choice reference to the declared modules', () => {
    const allowed = new Set([
      ...CHOICE_CODE_ALLOWED.keys(),
      ...CHOICE_PROSE_ONLY.keys(),
      ...CHOICE_NAMED_NOT_QUERIED.keys(),
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relativePath(file);
      if (allowed.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const term of CHOICE_TERMS) {
        if (text.includes(term))
          offenders.push(`${rel} references ${term} without being declared`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the two rule-declaring modules name choices only in prose', () => {
    // The narrow form of their exemption. Without this, a blanket allow-list
    // entry for a module whose whole job is to NOT touch choices would be the
    // widest hole in the file.
    const offenders: string[] = [];
    for (const rel of CHOICE_PROSE_ONLY.keys()) {
      const code = stripComments(read(rel));
      for (const term of CHOICE_TERMS) {
        if (code.includes(term)) offenders.push(`${rel} names ${term} in code`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the invariant gate name the choice table without querying it', () => {
    // The narrow form of ITS exemption, mirroring the prose-only pin above:
    // naming the table in a check name is the point, reading a row from it
    // never is. A gate that learned to join choices to turnout would be a
    // disclosure surface wearing the costume of a correctness check.
    const offenders: string[] = [];
    for (const rel of CHOICE_NAMED_NOT_QUERIED.keys()) {
      const raw = read(rel);
      for (const term of CHOICE_TERMS) {
        for (const clause of ['FROM', 'JOIN', 'INTO', 'UPDATE']) {
          if (new RegExp(String.raw`${clause}\s+${term}`, 'i').test(raw))
            offenders.push(`${rel} queries ${term} (${clause})`);
        }
      }
      for (const term of CANDIDATE_TERMS) {
        if (raw.includes(term)) offenders.push(`${rel} mentions ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the discovery, flag, ledger, and export machinery clean', () => {
    // #204: "No Audit Event, Review Flag, correlation, export, or log produced
    // by anything in this resolution may reference `ballot_choices` or
    // candidate selection." These five files are that "anything".
    const offenders: string[] = [];
    for (const rel of MACHINERY) {
      const raw = read(rel);
      const code = stripComments(raw);
      for (const term of [...CHOICE_TERMS, ...CANDIDATE_TERMS]) {
        if (code.includes(term)) offenders.push(`${rel} names ${term} in code`);
      }
      // A candidate COLUMN is never legitimate here, not even in a comment:
      // prose about "candidate selection" is the rule being stated, but
      // `candidate_id` in a comment is a query somebody drafted.
      for (const term of CANDIDATE_TERMS) {
        if (raw.includes(term)) offenders.push(`${rel} mentions ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives review_flags no choice-linked or candidate-linked column', () => {
    // The schema-level mirror of `verify:invariants`'
    // `no_flag_references_ballot_choices`, which asks the same question of the
    // live database (`pragma_table_info('review_flags')` for a name LIKE
    // '%choice%' or '%candidate%'). Asserting it against the source too means
    // the column cannot be ADDED and then merely fail an operator-run gate.
    const schema = read('server/db/audit-schema.ts');
    const start = schema.indexOf('export const reviewFlags = sqliteTable(');
    expect(start).toBeGreaterThan(-1);
    // From the export to the next one: the preceding header comment (which
    // states the prohibition, and so names it) is deliberately outside.
    const rest = schema.slice(start + 1);
    const end = rest.indexOf('\nexport const ');
    const region = end === -1 ? rest : rest.slice(0, end);

    for (const term of ['ballot_choice', 'candidate']) {
      expect(region).not.toContain(term);
    }
    // And the columns it does carry reach only the identity-linked turnout
    // row and the occasion-scoped records a human may act on.
    expect(region).toContain('impacted_ballot_id');
  });
});
