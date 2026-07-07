import { describe, it, expect } from 'vitest';
import {
  buildHashUpdateSql,
  planExactDeletions,
} from '../../scripts/dedupe-documents';
import type { DocLike } from '../../src/server/content/dedupe';

const doc = (over: Partial<DocLike>): DocLike => ({
  id: 'id',
  title: 't',
  filename: 'f.pdf',
  sizeBytes: 1,
  contentType: 'application/pdf',
  visibility: 'board',
  ...over,
});

describe('buildHashUpdateSql', () => {
  it('emits an UPDATE per row and escapes single quotes in ids', () => {
    const sql = buildHashUpdateSql([
      { id: 'a', contentHash: 'h1' },
      { id: "o'brien", contentHash: 'h2' },
    ]);
    expect(sql).toContain(
      "UPDATE documents SET content_hash = 'h1' WHERE id = 'a';",
    );
    expect(sql).toContain("id = 'o''brien'");
  });
});

describe('planExactDeletions', () => {
  it('plans deletions only for same-tier exact groups', () => {
    const sameTier = {
      members: [
        doc({ id: 'keep', filename: 'a.pdf', visibility: 'board' }),
        doc({ id: 'drop', filename: 'a(1).pdf', visibility: 'board' }),
      ],
      suggestedKeepId: 'keep',
    };
    const crossTier = {
      members: [
        doc({ id: 'p', visibility: 'public' }),
        doc({ id: 'b', visibility: 'board' }),
      ],
      suggestedKeepId: 'p',
    };
    expect(planExactDeletions([sameTier, crossTier])).toEqual([
      { keepId: 'keep', deleteIds: ['drop'] },
    ]);
  });
});
