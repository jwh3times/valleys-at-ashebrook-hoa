import { describe, it, expect } from 'vitest';
import {
  decide,
  missingMigrations,
} from '../../scripts/check-migrations-current';

// The `db:migrate:remote` freshness guard.
//
// It exists because of the 2026-08-21 `0029` apply: run from a checkout that
// predated the merge, `wrangler d1 migrations apply` reported "No migrations to
// apply!" — true of that disk, and indistinguishable from success — while
// production served already-deployed code against the old schema.
//
// What is tested here is the DECISION and its message, not git. The IO shell is
// a few `execFileSync` calls; the part worth pinning is that a behind checkout
// refuses, that the refusal names what is missing, and that the two
// can't-verify paths stay open rather than blocking an operator mid-incident.

describe('missingMigrations', () => {
  it('names the upstream migrations this checkout has never seen', () => {
    expect(
      missingMigrations(
        ['0027_a.sql', '0028_b.sql'],
        ['0027_a.sql', '0028_b.sql', '0029_c.sql'],
      ),
    ).toEqual(['0029_c.sql']);
  });

  it('is empty when the checkout has everything upstream does', () => {
    expect(missingMigrations(['0028_b.sql'], ['0028_b.sql'])).toEqual([]);
  });

  it('ignores local-only files rather than reporting them as a gap', () => {
    // An unmerged migration on a feature branch is not a reason to refuse; the
    // question is only what the checkout is MISSING.
    expect(
      missingMigrations(['0028_b.sql', '0030_wip.sql'], ['0028_b.sql']),
    ).toEqual([]);
  });
});

describe('decide', () => {
  const base = { behind: 0, missing: [], override: false, fetched: true };

  it('allows a checkout level with upstream', () => {
    const d = decide(base);
    expect(d.ok).toBe(true);
    expect(d.message).toContain('level with origin/main');
  });

  it('refuses a behind checkout and names the missing migrations', () => {
    const d = decide({
      ...base,
      behind: 2,
      missing: ['0029_adr0022_repoint_member_identity.sql'],
    });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('2 commits behind');
    expect(d.message).toContain('0029_adr0022_repoint_member_identity.sql');
    // The refusal has to explain the trap, not just deny — an operator who
    // does not know why will reach for the override.
    expect(d.message).toContain('indistinguishable from success');
    expect(d.message).toContain('git pull');
  });

  it('singularizes a one-commit gap', () => {
    expect(decide({ ...base, behind: 1 }).message).toContain('1 commit behind');
  });

  it('still refuses when behind with no migration files missing', () => {
    // Being behind at all means this is not provably the tree the deployed
    // code came from, even when no migration is involved.
    const d = decide({ ...base, behind: 3 });
    expect(d.ok).toBe(false);
    expect(d.message).toContain('No migration files are missing');
  });

  it('proceeds under the documented override, saying so', () => {
    const d = decide({
      ...base,
      behind: 5,
      missing: ['0029_x.sql'],
      override: true,
    });
    expect(d.ok).toBe(true);
    expect(d.message).toContain('MIGRATE_ALLOW_BEHIND');
  });

  it('proceeds but warns when upstream could not be refreshed', () => {
    // Failing closed here would block an operator whose network is flaky
    // during an incident — exactly when applying matters most.
    const d = decide({ ...base, fetched: false });
    expect(d.ok).toBe(true);
    expect(d.message).toContain('Could not reach origin/main');
  });
});
