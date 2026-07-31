import { describe, it, expect } from 'vitest';
import { REPORT_TEMPLATES } from '../../src/lib/reports';
import { INPUT_LIMITS } from '../../src/lib/types';

describe('REPORT_TEMPLATES', () => {
  it('defines six well-formed templates', () => {
    expect(REPORT_TEMPLATES).toHaveLength(6);
    for (const t of REPORT_TEMPLATES) {
      expect(t.key).toMatch(/^[a-z-]+$/);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.subQueries.length).toBeGreaterThanOrEqual(3);
      expect(t.subQueries.length).toBeLessThanOrEqual(6);
      for (const q of t.subQueries) expect(q.trim().length).toBeGreaterThan(0);
    }
  });

  it('has unique keys', () => {
    const keys = REPORT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('INPUT_LIMITS.reportTopic', () => {
  it('caps freeform topics at 200 chars', () => {
    expect(INPUT_LIMITS.reportTopic).toBe(200);
  });
});
