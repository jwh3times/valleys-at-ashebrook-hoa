import { describe, it, expect } from 'vitest';
import {
  toDocumentEntry,
  ragKeyFor,
} from '../../scripts/corpus-import-meta.ts';

const m = {
  relativePath: 'Documents/Governing Documents/By-Laws.pdf',
  title: 'Bylaws',
  category: 'Governing Documents',
  visibility: 'public',
  ragRelPath: '01-governing-documents/by-laws.md',
};

describe('corpus-import-meta', () => {
  it('builds a DocumentEntry with a documents/<id>/ key and safe name', () => {
    const e = toDocumentEntry(m, 'id-1');
    expect(e.id).toBe('id-1');
    expect(e.r2Key).toBe('documents/id-1/By-Laws.pdf');
    expect(e.filename).toBe('By-Laws.pdf');
    expect(e.title).toBe('Bylaws');
    expect(e.category).toBe('Governing Documents');
    expect(e.visibility).toBe('public');
    expect(e.contentType).toBe('application/pdf');
  });
  it('derives the rag twin key from the uuid', () => {
    expect(ragKeyFor('id-1')).toBe('rag/id-1.md');
  });
});
