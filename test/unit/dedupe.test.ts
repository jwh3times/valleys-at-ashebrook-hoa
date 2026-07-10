import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  normalizeName,
  tokenSimilarity,
  sizeSimilar,
  nearScore,
  NEAR_THRESHOLD,
  suggestedKeepId,
  groupExact,
  groupNear,
  autoResolvableExact,
  type DocLike,
} from '../../src/server/content/dedupe';

const doc = (over: Partial<DocLike>): DocLike => ({
  id: 'id',
  title: 't',
  filename: 'f.pdf',
  sizeBytes: 1000,
  contentType: 'application/pdf',
  visibility: 'board',
  ...over,
});

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex (known vector for empty input)', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('is stable and equal for identical byte content', async () => {
    const a = await sha256Hex(new TextEncoder().encode('hello'));
    const b = await sha256Hex(new TextEncoder().encode('hello'));
    expect(a).toBe(b);
  });
});

describe('normalizeName', () => {
  it('strips extension, lowercases, and tokenizes', () => {
    expect(normalizeName('By-Laws.pdf')).toEqual(['by', 'laws']);
  });
  it('strips a (1) copy suffix so a copy matches its original', () => {
    expect(normalizeName('CAMS Settings(1).pdf')).toEqual(
      normalizeName('CAMS Settings.pdf'),
    );
  });
  it('strips a _YYYYMMDD-HHMM timestamp stamp', () => {
    expect(normalizeName('ARC Form_20241216-1453.pdf')).toEqual(
      normalizeName('ARC Form.pdf'),
    );
  });
});

describe('tokenSimilarity', () => {
  it('is 1 for identical token sets', () => {
    expect(tokenSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });
  it('is 0 for disjoint token sets', () => {
    expect(tokenSimilarity(['a'], ['b'])).toBe(0);
  });
});

describe('sizeSimilar', () => {
  it('is true for identical sizes', () => {
    expect(sizeSimilar(1000, 1000)).toBe(true);
  });
  it('is false for sizes well outside tolerance', () => {
    expect(sizeSimilar(1000, 2000)).toBe(false);
  });
});

describe('nearScore', () => {
  it('scores an identical filename in two folders above threshold', () => {
    const a = doc({ id: 'a', title: 'ARC Form', filename: 'ARC Form.pdf' });
    const b = doc({ id: 'b', title: 'ARC Form', filename: 'ARC Form.pdf' });
    expect(nearScore(a, b)).toBeGreaterThanOrEqual(NEAR_THRESHOLD);
  });
  it('scores genuinely different documents below threshold', () => {
    const a = doc({ id: 'a', title: 'By-Laws', filename: 'By-Laws.pdf' });
    const b = doc({
      id: 'b',
      title: 'Articles of Incorporation',
      filename: 'Articles of Incorporation.pdf',
    });
    expect(nearScore(a, b)).toBeLessThan(NEAR_THRESHOLD);
  });
  it('is 0 when content types differ regardless of name', () => {
    const a = doc({ filename: 'Report.pdf', contentType: 'application/pdf' });
    const b = doc({ filename: 'Report.csv', contentType: 'text/csv' });
    expect(nearScore(a, b)).toBe(0);
  });
});

describe('suggestedKeepId', () => {
  it('prefers the clean filename over a (1) copy', () => {
    const clean = doc({ id: 'clean', filename: 'Settings.pdf' });
    const copy = doc({ id: 'copy', filename: 'Settings(1).pdf' });
    expect(suggestedKeepId([copy, clean])).toBe('clean');
  });
});

describe('groupExact', () => {
  it('groups documents that share a content hash, ignoring null hashes', () => {
    const docs = [
      doc({ id: 'a', contentHash: 'h1' }),
      doc({ id: 'b', contentHash: 'h1' }),
      doc({ id: 'c', contentHash: 'h2' }),
      doc({ id: 'd', contentHash: null }),
    ];
    const groups = groupExact(docs);
    expect(groups.length).toBe(1);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('groups identically whether or not members are kept-verified', () => {
    const base = [
      doc({ id: 'a', contentHash: 'h1' }),
      doc({ id: 'b', contentHash: 'h1' }),
    ];
    const verified = [
      doc({ id: 'a', contentHash: 'h1', keepVerifiedAt: Date.now() }),
      doc({ id: 'b', contentHash: 'h1', keepVerifiedAt: new Date() }),
    ];
    expect(groupExact(verified).map((g) => g.members.map((m) => m.id))).toEqual(
      groupExact(base).map((g) => g.members.map((m) => m.id)),
    );
  });
});

describe('groupNear', () => {
  it('groups near-duplicates but excludes exact-hash pairs', () => {
    const docs = [
      doc({
        id: 'a',
        title: 'ARC Form',
        filename: 'ARC Form.pdf',
        contentHash: 'h1',
      }),
      doc({
        id: 'b',
        title: 'ARC Form',
        filename: 'ARC Form.pdf',
        contentHash: 'h1',
      }),
      doc({
        id: 'c',
        title: 'ARC Form',
        filename: 'ARC Form(1).pdf',
        contentHash: 'h2',
      }),
    ];
    const groups = groupNear(docs);
    // a & b are an exact pair (skipped here); c is near a/b by name -> one near group forms
    expect(groups.length).toBe(1);
    expect(groups[0].members.map((m) => m.id)).toContain('c');
  });
});

describe('autoResolvableExact', () => {
  it('returns keep/delete for a same-tier exact group', () => {
    const g = {
      members: [
        doc({ id: 'keep', filename: 'a.pdf', visibility: 'board' }),
        doc({ id: 'drop', filename: 'a(1).pdf', visibility: 'board' }),
      ],
      suggestedKeepId: 'keep',
    };
    expect(autoResolvableExact(g)).toEqual({
      keepId: 'keep',
      deleteIds: ['drop'],
    });
  });
  it('refuses to auto-resolve an exact group spanning tiers', () => {
    const g = {
      members: [
        doc({ id: 'a', visibility: 'public' }),
        doc({ id: 'b', visibility: 'board' }),
      ],
      suggestedKeepId: 'a',
    };
    expect(autoResolvableExact(g)).toBeNull();
  });
});
