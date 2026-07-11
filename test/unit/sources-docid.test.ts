import { describe, it, expect } from 'vitest';
import { docIdFromFolder } from '../../src/server/ai/sources';

describe('docIdFromFolder', () => {
  it('parses the uuid from a documents/ key', () => {
    expect(docIdFromFolder('documents/abc-123/bylaws.pdf')).toBe('abc-123');
  });
  it('parses the uuid from a rag/ markdown key', () => {
    expect(docIdFromFolder('rag/abc-123.md')).toBe('abc-123');
  });
  it('returns null for an unrelated key', () => {
    expect(docIdFromFolder('other/x.md')).toBeNull();
  });
});
