import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext, Role } from '../authz/guards';
import type { Visibility } from '../../lib/types';
import { documents } from '../db/schema';
import { TENANT_ACCESS_ENABLED_SQL } from '../roster/tenancy';

const VIS_RANK: Record<Visibility, number> = {
  public: 0,
  homeowner: 1,
  board: 2,
};
const ROLE_RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

export function tierAllows(role: Role, visibility: Visibility): boolean {
  return (ROLE_RANK[role] ?? 0) >= VIS_RANK[visibility];
}

export function visibleTiers(role: Role): Visibility[] {
  const rank = ROLE_RANK[role] ?? 0;
  return (['public', 'homeowner', 'board'] as Visibility[]).filter(
    (v) => VIS_RANK[v] <= rank,
  );
}

/** Who is reading. `null` is an anonymous visitor. */
export type DocumentReader = Pick<AuthContext, 'contentTier' | 'capabilities'>;

/**
 * The one answer to "may this reader see this document" (#294, ADR 0028), as
 * a condition on `documents`. The list and the download both filter with it,
 * so they can never disagree about a document.
 *
 * A tenant's `contentTier` stays `visitor`. Holding `tenant` adds the
 * Tenant-Visible documents, and only while both gates are on: the gate is
 * read inside the query, so turning it off takes effect on the next request.
 */
export function documentVisibleTo(reader: DocumentReader | null): SQL {
  const byTier = inArray(
    documents.visibility,
    visibleTiers(reader?.contentTier ?? 'visitor'),
  );
  if (!reader?.capabilities.has('tenant')) return byTier;
  return or(
    byTier,
    and(eq(documents.tenantVisible, true), sql.raw(TENANT_ACCESS_ENABLED_SQL)),
  )!;
}
