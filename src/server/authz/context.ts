import { createAuth } from '../auth';
import { deriveAccess, type DerivedAccess } from './derive';
import { recordGrantRevalidationDenial } from './revalidation-event';
import type { AuthContext } from './guards';

/** Derived facts, shaped as an `AuthContext`. */
export function derivedContext(access: DerivedAccess): AuthContext {
  return {
    userId: access.userId,
    personId: access.personId,
    capabilities: access.capabilities,
    lotIds: access.lotIds,
    contentTier: access.contentTier,
    hasCurrentBoardTerm: access.hasCurrentBoardTerm,
  };
}

/** Resolve every authenticated caller from current roster facts. Database errors
 * propagate rather than turning a temporarily unreadable grant into a denial. */
export async function getAuthContext(
  request: Request,
  env: Env,
  associationDay: string,
): Promise<AuthContext | null> {
  const result = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!result) return null;
  const access = await deriveAccess(env, result.user.id, associationDay);
  if (access.invalidBoardGrantId) {
    await recordGrantRevalidationDenial(env, {
      accountId: result.user.id,
      grantId: access.invalidBoardGrantId,
      associationDay,
    });
  }
  return derivedContext(access);
}
