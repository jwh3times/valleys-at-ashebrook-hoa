import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOT_SQL, TENANCY_SQL } from '../../src/server/authz/derive';
import { sourceFiles, tablesReferencedIn } from './table-references';

/**
 * A Tenancy grants no Lot Authority (ADR 0028). Tenants live on the Lot but
 * never act for it: no proxy, no vote, no Lot Record, no Board eligibility.
 * That holds only while nothing that answers Lot Authority reads a tenancy
 * table, so this pins it statically, the way `legacy-roster-consumers` pins
 * the dropped tables.
 *
 * `derive.ts` itself must name `tenancies` (it derives the `tenant`
 * capability), so the scan covers the `LOT_SQL` constant rather than the file.
 */
const TENANCY_TABLES: Record<string, string> = {
  tenancies: 'tenancies',
  tenancyRequests: 'tenancy_requests',
  tenancyInvitations: 'tenancy_invitations',
};

/** Importing the tenancy module would reach the table through its SQL
 * fragments, which name only an alias, so it is forbidden too. */
const TENANCY_MODULE_IMPORT =
  /from\s+['"][^'"]*roster\/tenancy['"]|from\s+['"]\.\/tenancy['"]/;

const AUTHORITY_MODULES = [
  'src/server/roster/authority.ts',
  'src/server/roster/board-consequences.ts',
];

describe('Lot Authority never reads a Tenancy', () => {
  for (const path of AUTHORITY_MODULES)
    it(`${path} names no tenancy table`, () => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(tablesReferencedIn(source, TENANCY_TABLES)).toEqual([]);
      expect(source).not.toMatch(TENANCY_MODULE_IMPORT);
    });

  it('LOT_SQL names no tenancy table', () => {
    expect(tablesReferencedIn(LOT_SQL, TENANCY_TABLES)).toEqual([]);
  });

  it('LOT_SQL embeds no tenancy predicate', () => {
    expect(LOT_SQL).not.toMatch(/tenan/i);
  });

  it('would catch one: the tenant statement is seen to read tenancies', () => {
    // The scan's own sensitivity check. If the pattern stopped matching, the
    // assertions above would pass vacuously.
    expect(tablesReferencedIn(TENANCY_SQL, TENANCY_TABLES)).toEqual([
      'tenancies',
    ]);
    expect(
      tablesReferencedIn(
        "import { tenancies } from '../db/roster-schema';",
        TENANCY_TABLES,
      ),
    ).toEqual(['tenancies']);
    expect("import { tenancyCurrentSql } from './tenancy';").toMatch(
      TENANCY_MODULE_IMPORT,
    );
    expect("import { tenancyCurrentSql } from '../roster/tenancy';").toMatch(
      TENANCY_MODULE_IMPORT,
    );
  });
});

/**
 * A request and an invitation hold a tenant's name and contact before the
 * roster does, where neither Roster Redaction nor the AI pseudonymizer
 * reaches them (spec decision 3). The AI surfaces must therefore never read
 * them: `src/server/ai/` feeds the assistant, the report generator and the
 * pseudonymizer's dictionary.
 */
const REQUEST_TABLES: Record<string, string> = {
  tenancyRequests: 'tenancy_requests',
  tenancyInvitations: 'tenancy_invitations',
};

describe('the AI surfaces never read a tenancy request or invitation', () => {
  const AI_DIR = join(process.cwd(), 'src', 'server', 'ai');

  it('scans a real directory, so a rename fails loudly instead of quietly', () => {
    expect(sourceFiles(AI_DIR).length).toBeGreaterThan(0);
  });

  it('names neither table in any file under src/server/ai', () => {
    const offenders = sourceFiles(AI_DIR).flatMap((file) =>
      tablesReferencedIn(readFileSync(file, 'utf8'), REQUEST_TABLES).map(
        (table) => `${file.slice(process.cwd().length + 1)}: ${table}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('would catch one, by table name or Drizzle import', () => {
    expect(
      tablesReferencedIn(
        'SELECT tenant_name FROM tenancy_requests',
        REQUEST_TABLES,
      ),
    ).toEqual(['tenancy_requests']);
    expect(
      tablesReferencedIn(
        "import { tenancyRequests } from '../db/roster-schema';",
        REQUEST_TABLES,
      ),
    ).toEqual(['tenancy_requests']);
    expect(
      tablesReferencedIn(
        'SELECT token_hash FROM tenancy_invitations',
        REQUEST_TABLES,
      ),
    ).toEqual(['tenancy_invitations']);
    expect(
      tablesReferencedIn(
        "import { tenancyInvitations } from '../db/roster-schema';",
        REQUEST_TABLES,
      ),
    ).toEqual(['tenancy_invitations']);
  });
});
