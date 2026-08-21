import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ADR 0022 phase 4 (#212) precondition, per #246: every `src/` module that
 * reads a legacy roster table phase 4 DROPS is declared here, together with
 * what phase 4 must do about it.
 *
 * This exists because of #233. The pseudonymizer read the roster from `owners`,
 * the flip made the party roster authoritative, and nothing noticed — no error,
 * no failing test, just a smaller PII dictionary and an unmasked name in an
 * outbound payload. The post-mortem's transferable lesson: the flip's checklist
 * verified that AUTHORIZATION stopped reading the legacy model, and never
 * enumerated the non-authorization consumers. `authz-legacy-role.test.ts` scans
 * for `users.role`; this is the scan for the tables themselves.
 *
 * The value is not the snapshot — an audit rots. It is that a NEW consumer of a
 * doomed table cannot be added without declaring it, and that phase 4's job
 * becomes "empty the needs-repointing list" rather than "go find them all".
 *
 * TWO SIGNALS, deliberately. `authz-legacy-role.test.ts` reasons that imports
 * are unambiguous where property access is not, and that is right — but an
 * import-only scan MISSES `server/roster/verification.ts`, whose
 * `user_property_links` mirror is a raw INSERT with no Drizzle symbol imported.
 * That near-miss is why raw SQL is scanned too (#246).
 */

const SRC = join(process.cwd(), 'src');

/**
 * The tables #212 DROPS, in both spellings the codebase uses.
 *
 * `properties` is deliberately absent: phase 4 RENAMES it to `lots` rather than
 * dropping it. Twenty-eight modules touch it, a rename is a mechanical edit
 * rather than a data-loss hazard, and including it would swamp the signal this
 * file exists to carry.
 */
const DROPPED: Record<string, string> = {
  owners: 'owners',
  userPropertyLinks: 'user_property_links',
  propertyVerifications: 'property_verifications',
  manualApprovalQueue: 'manual_approval_queue',
  boardPeople: 'board_people',
  boardTerms: 'board_terms',
};

/**
 * What phase 4 has to do about a consumer. An entry carries the HIGHEST-effort
 * disposition that applies to it, so a module with two kinds of reference never
 * gets under-planned.
 */
type Disposition =
  /** The module IS a legacy surface #212 deletes. Nothing to repoint. */
  | 'deleted-with-the-table'
  /** Writes a mirror nothing reads for behavior. Delete the write. */
  | 'write-behind-mirror'
  /** Already reads BOTH models. Phase 4 deletes the legacy arm only. */
  | 'already-dual-read'
  /** Live behavior on a doomed table. THE PHASE-4 WORK LIST. */
  | 'needs-repointing'
  /** Reads `board_people`; waits on the meeting record's Person repointing. */
  | 'blocked-on-person-repointing';

interface Consumer {
  disposition: Disposition;
  reason: string;
}

const CONSUMERS = new Map<string, Consumer>([
  // ---- Legacy surfaces phase 4 deletes outright -------------------------
  [
    'pages/api/admin/owners.ts',
    {
      disposition: 'deleted-with-the-table',
      reason:
        'the legacy Owners admin route; #212 deletes the legacy Properties, ' +
        'Owners, and Members panels along with the table',
    },
  ],
  [
    'pages/api/admin/properties.ts',
    {
      disposition: 'deleted-with-the-table',
      reason: 'the legacy Properties admin route, which lists owners per lot',
    },
  ],
  [
    'server/authz/context.ts',
    {
      disposition: 'deleted-with-the-table',
      reason:
        'the `legacy` branch of the cutover seam — the ONE place allowed to ' +
        'read the legacy roster as an authorization fact, deleted whole by ' +
        'phase 4 (see authz-legacy-role.test.ts)',
    },
  ],
  [
    'server/verification/property.ts',
    {
      disposition: 'deleted-with-the-table',
      reason:
        'the legacy-mode verification backend; the derived Person flow in ' +
        'server/roster/verification.ts replaces it entirely',
    },
  ],
  [
    'server/cleanup/verification.ts',
    {
      disposition: 'deleted-with-the-table',
      reason:
        'the retention sweep — its property_verifications and ' +
        'manual_approval_queue passes have nothing left to sweep once those ' +
        'tables are gone',
    },
  ],

  // ---- Write-behind mirrors: delete the write ---------------------------
  [
    'server/roster/verification.ts',
    {
      disposition: 'write-behind-mirror',
      reason:
        'the derived confirm raw-INSERTs user_property_links, kept only so ' +
        'the legacy read model stays coherent through the flip. Found by the ' +
        'raw-SQL signal alone — it imports no Drizzle symbol for it',
    },
  ],
  [
    'pages/api/admin/members.ts',
    {
      disposition: 'write-behind-mirror',
      reason:
        'revocation mirrors a user_property_links DELETE, and the route still ' +
        'renders the legacy manual-approval queue (write-dead since v0.10.0). ' +
        'Both halves are deletions, not repointings',
    },
  ],

  // ---- Already reading both models --------------------------------------
  [
    'server/ai/assistant.ts',
    {
      disposition: 'already-dual-read',
      reason:
        'loadRosterEntries unions the party roster with owners, the #233 fix ' +
        '(v0.13.5). Phase 4 drops the legacy arm only — before that fix, ' +
        'dropping owners would have emptied the PII dictionary rather than ' +
        'merely thinning it',
    },
  ],

  // ---- THE PHASE-4 WORK LIST: live behavior on a doomed table -----------
  [
    'server/content/proxy-guards.ts',
    {
      disposition: 'needs-repointing',
      reason:
        'proxyUseError re-validates a proxy grantor against owners.status in ' +
        'BOTH cutover modes — a deliberate current-state approximation (#220, ' +
        'decided by #204), documented in the module header',
    },
  ],
  [
    'server/content/voting.ts',
    {
      disposition: 'needs-repointing',
      reason:
        'the atomic cast re-checks own-lot and held-proxy authority by ' +
        'joining owners and user_property_links inside the mutation SQL',
    },
  ],
  [
    'server/content/voting-reads.ts',
    {
      disposition: 'needs-repointing',
      reason:
        'the caller-specific open-voting projection resolves active owners of ' +
        'the caller lots into valid provenance options',
    },
  ],
  [
    'server/content/casting-authority.ts',
    {
      disposition: 'needs-repointing',
      reason: 'the verified lots of a caller, read from user_property_links',
    },
  ],
  [
    'server/content/reads.ts',
    {
      disposition: 'needs-repointing',
      reason:
        'proxy and member-lot reads resolve grantor and holder names from ' +
        'owners. Its board_people half is gone: #248 repointed the ' +
        'meeting-record name map at the party roster',
    },
  ],
  [
    'server/roster/lookup.ts',
    {
      disposition: 'needs-repointing',
      reason: 'the active owners of a lot, behind the member address lookup',
    },
  ],
  [
    'pages/api/admin/proxies.ts',
    {
      disposition: 'needs-repointing',
      reason:
        'the board proxies record validates grantor and holder against owners',
    },
  ],
  [
    'pages/api/member/proxies.ts',
    {
      disposition: 'needs-repointing',
      reason: 'the homeowner proxy grant flow picks grantor and holder owners',
    },
  ],

  // ---- Blocked on the meeting record Person repointing ------------------
  // EMPTY since #248 part 1, which repointed the meeting and elections records
  // at `people(party_id)` and closed this category. Kept as a heading because
  // the category is still meaningful: `board_people` survives until phase 4
  // drops it, and a new reader of it belongs here rather than in the list
  // above.
]);

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

const relativePath = (file: string) => relative(SRC, file).split(sep).join('/');

/** URLs are neutralised first: a doc link would otherwise read as a line
 * comment and swallow the rest of its line, HIDING a reference rather than
 * merely over-reporting one. */
function stripComments(source: string): string {
  return source
    .replace(/https?:\/\//g, 'url_')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '');
}

/** Which dropped tables this source actually touches, by either signal. */
function droppedTablesIn(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();

  for (const match of code.matchAll(
    /import[^;]*?\{([^}]*)\}[^;]*?from[^;]*?['"][^'"]*(?:db\/schema|auth-schema)['"]/g,
  )) {
    for (const raw of match[1].split(',')) {
      const symbol = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (symbol in DROPPED) found.add(DROPPED[symbol]);
    }
  }

  for (const table of Object.values(DROPPED)) {
    const querying = new RegExp(
      String.raw`(FROM|JOIN|INTO|UPDATE|TABLE)\s+${table}\b`,
      'i',
    );
    if (querying.test(code)) found.add(table);
  }

  return [...found].sort();
}

const readSource = (rel: string) =>
  readFileSync(join(SRC, ...rel.split('/')), 'utf8');

describe('consumers of the legacy roster tables', () => {
  it('are all declared, so phase 4 has no unknown callers to discover', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relativePath(file);
      // server/db/ DEFINES these tables. The migrations that create them are
      // .sql/.json, which the source walk does not match anyway.
      if (rel.startsWith('server/db/')) continue;
      if (CONSUMERS.has(rel)) continue;

      const tables = droppedTablesIn(readFileSync(file, 'utf8'));
      if (tables.length > 0)
        offenders.push(
          `${rel} reads ${tables.join(', ')} without a declared disposition`,
        );
    }
    expect(offenders).toEqual([]);
  });

  it('have not been repointed already, leaving a stale declaration behind', () => {
    // The half that stops this file from rotting. An entry that no longer
    // matches reality is worse than no entry: it tells a future reader there is
    // work here when there is not, and phase 4 plans around it.
    const stale: string[] = [];
    for (const rel of CONSUMERS.keys()) {
      if (droppedTablesIn(readSource(rel)).length === 0)
        stale.push(`${rel} reads no dropped table any more — delete its entry`);
    }
    expect(stale).toEqual([]);
  });

  it('leave a phase-4 work list that is real work, not an empty gesture', () => {
    // If this ever reads zero, either phase 4 is finished or the scan broke.
    // Both deserve a human look, and a green suite would announce neither.
    const repointing = [...CONSUMERS.values()].filter(
      (c) => c.disposition === 'needs-repointing',
    );

    expect(repointing.length).toBeGreaterThan(0);
    for (const consumer of CONSUMERS.values())
      expect(consumer.reason.length).toBeGreaterThan(20);
  });
});
