import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOT_SQL, TENANCY_SQL } from '../../src/server/authz/derive';
import { tablesReferencedIn } from './table-references';

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

const AUTHORITY_MODULES = [
  'src/server/roster/authority.ts',
  'src/server/roster/board-consequences.ts',
];

describe('Lot Authority never reads a Tenancy', () => {
  for (const path of AUTHORITY_MODULES)
    it(`${path} names no tenancy table`, () => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(tablesReferencedIn(source, TENANCY_TABLES)).toEqual([]);
    });

  it('LOT_SQL names no tenancy table', () => {
    expect(tablesReferencedIn(LOT_SQL, TENANCY_TABLES)).toEqual([]);
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
  });
});
