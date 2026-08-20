import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #240 (per #206): the operator CLI gate and the Worker's daily scheduled run
 * must never disagree about what an invariant is.
 *
 * They cannot share an execution path — a Worker cannot spawn Wrangler — so
 * the anti-drift property is that neither caller carries a query of its own.
 * A behavioral test cannot catch this: a check copied into one caller and then
 * edited passes every test that caller has, and the two only disagree on a
 * database neither test touches.
 *
 * Scanning source text is crude, but the thing being prohibited IS text — a
 * SQL string literal. Nothing here executes; both callers are checked for the
 * shared import and for the absence of a query.
 */

const SHARED = join(process.cwd(), 'src', 'server', 'db', 'invariants.ts');

const CALLERS = [
  join(process.cwd(), 'scripts', 'verify-invariants.ts'),
  join(process.cwd(), 'src', 'server', 'scheduled.ts'),
];

/** The opening keyword of every check in the shared module. A caller holding
 * one of these is holding a check the other caller does not have. */
const QUERY_KEYWORDS = [/\bSELECT\b/, /\bPRAGMA\b/];

describe('invariant checks have a single source', () => {
  it.each(CALLERS)('%s runs the shared checks and defines none', (caller) => {
    const source = readFileSync(caller, 'utf8');

    expect(source).toMatch(/from\s+['"][^'"]*\/db\/invariants(\.ts)?['"]/);
    for (const keyword of QUERY_KEYWORDS) expect(source).not.toMatch(keyword);
  });

  it('the shared module is where the checks actually live', () => {
    const source = readFileSync(SHARED, 'utf8');

    expect(source).toMatch(/export const INVARIANT_CHECKS/);
    // A guard against the inverse mistake — emptying the shared list and
    // leaving both callers green because zero checks return zero rows.
    expect(source.match(/\bname:\s*'/g)?.length ?? 0).toBeGreaterThan(10);
  });
});
