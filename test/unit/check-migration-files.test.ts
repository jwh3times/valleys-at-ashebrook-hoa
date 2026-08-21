import { describe, it, expect } from 'vitest';
import { migrationProblems } from '../../scripts/check-migration-files';

// The migrations-directory gate (#257).
//
// `wrangler d1 migrations apply` reads the DIRECTORY, not `meta/_journal.json`
// — measured on 2026-08-21, and the opposite of what #248's notes assumed. So
// the hazard this guards is a stray or mis-numbered `.sql` file becoming a
// production migration, not a missing journal entry.
//
// Drizzle snapshots are deliberately unchecked: that chain is abandoned (#257),
// and a gate demanding one per migration would enforce a workflow this project
// does not use.

const entry = (idx: number, tag: string) => ({ idx, tag });

describe('migrationProblems', () => {
  it('passes a contiguous set that matches the journal', () => {
    expect(
      migrationProblems(
        ['0000_a.sql', '0001_b_c.sql', '0002_d.sql'],
        [entry(0, '0000_a'), entry(1, '0001_b_c'), entry(2, '0002_d')],
      ),
    ).toEqual([]);
  });

  it('rejects a stray file that does not follow the naming rule', () => {
    // The probe that proved wrangler applies unlisted files looked like this.
    const problems = migrationProblems(
      ['0000_a.sql', 'scratch.sql'],
      [entry(0, '0000_a')],
    );
    expect(problems.some((p) => p.startsWith('scratch.sql'))).toBe(true);
  });

  it('rejects two migrations claiming the same index', () => {
    // The realistic version: two branches both add 0030 and merge cleanly.
    const problems = migrationProblems(
      ['0000_a.sql', '0001_theirs.sql', '0001_ours.sql'],
      [entry(0, '0000_a'), entry(1, '0001_theirs'), entry(1, '0001_ours')],
    );
    expect(problems.some((p) => p.includes('duplicate index 0001'))).toBe(true);
  });

  it('rejects a gap left by a deleted or renamed migration', () => {
    const problems = migrationProblems(
      ['0000_a.sql', '0002_c.sql'],
      [entry(0, '0000_a'), entry(2, '0002_c')],
    );
    expect(problems.some((p) => p.includes('gap before 0002'))).toBe(true);
  });

  it('reports only the first gap, so one deletion is one message', () => {
    const problems = migrationProblems(
      ['0000_a.sql', '0003_d.sql', '0004_e.sql'],
      [entry(0, '0000_a'), entry(3, '0003_d'), entry(4, '0004_e')],
    );
    expect(problems.filter((p) => p.includes('gap before'))).toHaveLength(1);
  });

  it('flags a file missing from the journal, saying it applies regardless', () => {
    const problems = migrationProblems(
      ['0000_a.sql', '0001_b.sql'],
      [entry(0, '0000_a')],
    );
    const found = problems.find((p) => p.startsWith('0001_b.sql is on disk'));
    expect(found).toBeDefined();
    // The message must not repeat #248's mistaken belief that a missing entry
    // stops the migration running.
    expect(found).toContain('WILL apply');
  });

  it('flags a journal entry with no file behind it', () => {
    const problems = migrationProblems(
      ['0000_a.sql'],
      [entry(0, '0000_a'), entry(1, '0001_ghost')],
    );
    expect(problems.some((p) => p.includes('0001_ghost'))).toBe(true);
  });

  it('says nothing about drizzle snapshots, which are abandoned', () => {
    // Regression guard for the decision itself: if someone later makes this
    // gate demand snapshots, that reverses #257 option 2 and should be a
    // deliberate change, not a drive-by.
    const problems = migrationProblems(
      ['0000_a.sql'],
      [entry(0, '0000_a')],
    ).join(' ');
    expect(problems).not.toContain('snapshot');
  });
});
