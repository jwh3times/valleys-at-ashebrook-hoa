import { describe, it, expect } from 'vitest';
import { pathToDocMeta } from '../../scripts/doc-tiers';

describe('pathToDocMeta', () => {
  it('maps governing docs to public', () => {
    expect(
      pathToDocMeta('Documents/Governing Documents/By-Laws.pdf').visibility,
    ).toBe('public');
  });
  it('maps meeting minutes to homeowner', () => {
    expect(
      pathToDocMeta('Historical/8-Meetings/Annual/2024/Minutes.docx')
        .visibility,
    ).toBe('homeowner');
  });
  it('maps legal/collections to board', () => {
    expect(
      pathToDocMeta('Historical/7-Legal & Collections/Kornerstone.msg')
        .visibility,
    ).toBe('board');
  });
  it('defaults unmatched paths to board (fail-safe)', () => {
    expect(pathToDocMeta('Historical/Something New/x.pdf').visibility).toBe(
      'board',
    );
  });
});
