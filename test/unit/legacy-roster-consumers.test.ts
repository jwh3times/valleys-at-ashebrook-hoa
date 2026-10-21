import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sourceFiles, tablesReferencedIn } from './table-references';

/** Permanent guard against reintroducing references to removed roster tables. */
const SRC = join(process.cwd(), 'src');

const DROPPED: Record<string, string> = {
  owners: 'owners',
  userPropertyLinks: 'user_property_links',
  propertyVerifications: 'property_verifications',
  manualApprovalQueue: 'manual_approval_queue',
  boardPeople: 'board_people',
  properties: 'properties',
  boardServiceTerms: 'board_service_terms',
};

const relativePath = (file: string) => relative(SRC, file).split(sep).join('/');

describe('permanent roster schema', () => {
  it('has no serving-code references to removed or renamed tables', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const tables = tablesReferencedIn(readFileSync(file, 'utf8'), DROPPED);
      if (tables.length > 0)
        offenders.push(`${relativePath(file)} reads ${tables.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
