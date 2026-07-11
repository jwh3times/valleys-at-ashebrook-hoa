import { describe, it, expect } from 'vitest';
import { groupDocumentsByCategory } from '../../src/lib/content';
import type { DocumentItem } from '../../src/lib/types';

const doc = (id: string, category: string): DocumentItem =>
  ({
    id,
    title: id,
    category,
    visibility: 'public',
    updatedAt: '2026-01-01',
  }) as DocumentItem;

describe('groupDocumentsByCategory ordering', () => {
  it('orders groups by DOCUMENT_CATEGORIES, unknown categories last', () => {
    const groups = groupDocumentsByCategory([
      doc('a', 'Taxes'),
      doc('b', 'Governing Documents'),
      doc('c', 'Mystery'),
    ]);
    expect(Object.keys(groups)).toEqual([
      'Governing Documents',
      'Taxes',
      'Mystery',
    ]);
  });
});
