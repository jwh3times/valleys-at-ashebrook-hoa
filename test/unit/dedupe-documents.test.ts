import { describe, it, expect } from 'vitest';
import {
  buildHashUpdateSql,
  planDuplicateRemoval,
  planExactDeletions,
} from '../../scripts/dedupe-documents';
import type { DocumentEntry } from '../../scripts/import-documents';
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

describe('planDuplicateRemoval', () => {
  const entry = (id: string, r2Key: string): DocumentEntry => ({
    id,
    relativePath: `x/${id}.pdf`,
    filename: `${id}.pdf`,
    title: id,
    category: 'Governing Documents',
    visibility: 'board',
    r2Key,
    sizeBytes: 1,
    contentType: 'application/pdf',
  });

  it("removes each duplicate's file and its search twin (#442)", () => {
    const plan = planDuplicateRemoval(
      [entry('a', 'documents/a/A.pdf'), entry('b', 'documents/b/B.pdf')],
      ['a', "o'b"],
    );
    expect(plan.deleteRowsSql).toBe(
      "DELETE FROM documents WHERE id IN ('a', 'o''b');\n",
    );
    // An id missing from the manifest still loses its twin; its original is
    // left for the R2 orphan sweep, since only the manifest knows its key.
    expect(plan.r2Keys).toEqual([
      'documents/a/A.pdf',
      'rag/a.md',
      "rag/o'b.md",
    ]);
  });

  it('plans nothing when there is nothing to delete', () => {
    expect(planDuplicateRemoval([entry('a', 'documents/a/A.pdf')], [])).toEqual(
      { deleteRowsSql: null, r2Keys: [] },
    );
  });
});
