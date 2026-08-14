import type { AuthContext } from './guards';

// The pure half of the ADR 0022 shadow comparison (issue #210, phase 2).
//
// Split out from `shadow.ts` for one concrete reason: the OFFLINE SWEEP runs
// under `node --experimental-strip-types`, which resolves ESM imports literally
// and cannot follow `shadow.ts`'s value import of `derive.ts`. This module has
// only a type import, so it is erased at load and the sweep can share the exact
// comparison the request path uses instead of carrying its own copy.

export type ShadowSource = 'request' | 'sweep';

export interface ShadowComparison {
  matched: boolean;
  legacyRole: string;
  derivedContentTier: string;
  legacyLotCount: number;
  derivedLotCount: number;
}

/**
 * Pure comparison, so the decision of what counts as a mismatch is testable
 * without a database.
 *
 * Compares the content tier and the lot SET — sorted and de-duplicated, because
 * ordering is an artifact of the query plan and would otherwise report a
 * mismatch that does not exist.
 */
export function compareContexts(
  legacy: Pick<AuthContext, 'role' | 'propertyIds'>,
  derived: { contentTier: string; lotIds: string[] },
): ShadowComparison {
  const legacyLots = [...new Set(legacy.propertyIds)].sort();
  const derivedLots = [...new Set(derived.lotIds)].sort();
  return {
    matched:
      legacy.role === derived.contentTier &&
      legacyLots.length === derivedLots.length &&
      legacyLots.every((id, i) => id === derivedLots[i]),
    legacyRole: legacy.role,
    derivedContentTier: derived.contentTier,
    legacyLotCount: legacyLots.length,
    derivedLotCount: derivedLots.length,
  };
}
