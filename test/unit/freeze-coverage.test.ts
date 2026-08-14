import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  freezePolicyFor,
  alwaysLivePaths,
  isMutatingMethod,
} from '../../src/server/authz/write-freeze';

/**
 * Structural guard on write-freeze COVERAGE, sibling of
 * admin-routes-all-gated.test.ts and member-routes-all-gated.test.ts.
 *
 * Those two prove every route has its auth gate. This one proves every route
 * that can change state is actually reached by the freeze — the failure they
 * were written for, applied to the other axis.
 *
 * The freeze is deny-by-default, so this test is not "did someone remember to
 * add the new route to a list". It is the inverse and much stronger: a route
 * can only end up live-while-frozen by matching an exemption, and every
 * exemption has to be declared HERE as well as in write-freeze.ts. Two
 * independent edits, in two files, with the reason spelled out in both.
 */

const API = join(process.cwd(), 'src', 'pages', 'api');

/**
 * The complete set of mutating routes that keep working during a freeze.
 *
 * Adding an entry here means asserting that freezing the route would break the
 * freeze's own purpose. That is true of exactly these two:
 *
 *  - Sign-in, because an operator locked out of the admin panel cannot run the
 *    flip the freeze exists for.
 *  - First-board bootstrap, because flip step 4 creates the first System
 *    Administrator while the freeze is still on.
 *
 * Anything else that wants to be here is almost certainly a mistake.
 */
const DELIBERATELY_LIVE = new Set(['/api/auth/all', '/api/bootstrap/board']);

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * `src/pages/api/auth/[...all].ts` -> `/api/auth/all`. Dynamic segments are
 * flattened to a concrete-looking path so freezePolicyFor can be asked about a
 * real request path rather than a route pattern.
 */
function routePath(file: string): string {
  const rel = relative(API, file).split('\\').join('/').replace(/\.ts$/, '');
  return `/api/${rel.replace(/\[\.\.\.([^\]]+)\]/g, '$1').replace(/\[([^\]]+)\]/g, '$1')}`;
}

function exportedVerbs(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return VERBS.filter((v) =>
    new RegExp(`export const ${v}\\b`).test(text),
  ) as string[];
}

const routes = routeFiles(API).map((file) => ({
  file,
  path: routePath(file),
  verbs: exportedVerbs(file),
}));

describe('write-freeze coverage', () => {
  it('found the API routes to check', () => {
    // Guards against a glob that silently matches nothing, which would make
    // every assertion below vacuously pass.
    expect(routes.length).toBeGreaterThanOrEqual(30);
  });

  it('every route exports at least one verb', () => {
    // A route file with no recognised verb would be skipped by the mutation
    // check below without anyone noticing.
    expect(routes.filter((r) => r.verbs.length === 0)).toEqual([]);
  });

  it('freezes every mutating route that is not a declared exemption', () => {
    const live: string[] = [];
    for (const { path, verbs } of routes) {
      const mutates = verbs.some((v) => v === 'ALL' || isMutatingMethod(v));
      if (!mutates) continue;
      if (freezePolicyFor(path) !== 'exempt') continue;
      if (DELIBERATELY_LIVE.has(path)) continue;
      live.push(path);
    }
    expect(live).toEqual([]);
  });

  it('declares the same exemptions the policy grants', () => {
    // Both directions. A path exempted in write-freeze.ts but not declared
    // here is an undocumented hole; a path declared here that the policy no
    // longer exempts is a stale claim.
    const granted = routes
      .map((r) => r.path)
      .filter((p) => freezePolicyFor(p) === 'exempt')
      .sort();
    expect(granted).toEqual([...DELIBERATELY_LIVE].sort());
  });

  it('keeps the exemption list to the two paths that need it', () => {
    // Not a style rule. Every entry is a mutating surface that stays open
    // while the site is meant to be still, so growth here is the thing most
    // worth noticing in review.
    expect(alwaysLivePaths().sort()).toEqual([
      '/api/auth',
      '/api/bootstrap/board',
    ]);
  });

  it('freezes the homeowner-write surfaces on reads as well as writes', () => {
    expect(freezePolicyFor('/api/member/proxies')).toBe('everything');
    expect(freezePolicyFor('/api/vote')).toBe('everything');
  });

  it('leaves admin reads live while freezing admin writes', () => {
    expect(freezePolicyFor('/api/admin/meetings')).toBe('mutations');
  });

  it('freezes homeowner verification, which writes the tables the backfill reads', () => {
    expect(freezePolicyFor('/api/verify/confirm')).toBe('mutations');
    expect(freezePolicyFor('/api/verify/request')).toBe('mutations');
  });

  it('matches path segments rather than bare prefixes', () => {
    // /api/administrators is not under /api/admin, and /api/members is not
    // under /api/member — the same trap isAdminApi/isMemberApi guard against.
    expect(freezePolicyFor('/api/members')).toBe('mutations');
    expect(freezePolicyFor('/api/authorize')).not.toBe('exempt');
  });

  it('defaults an unknown path to frozen-on-mutation', () => {
    // The property the whole design rests on: a route nobody has written yet
    // is already covered.
    expect(freezePolicyFor('/api/not-built-yet')).toBe('mutations');
    expect(freezePolicyFor('/some/page')).toBe('mutations');
  });
});
