import type { APIRoute } from 'astro';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { writeFreezeError } from '../../../server/authz/write-freeze';
import { getDb } from '../../../server/db/client';
import { personLinks } from '../../../server/db/roster-schema';
import {
  isBatchAssertionError,
  operationKey,
} from '../../../server/roster/audit';
import {
  endLinkStatements,
  denyIfLastSystemAdministrator,
} from '../../../server/roster/identity';

// ADR 0022 phase 3c (#219): the applicant's ALWAYS-available self-unlink.
// Deliberately outside `/api/member/*` and outside `officialMode` — an
// account must be able to end its own Person Link regardless of site mode,
// so the only gates are the write freeze and an authenticated session.
//
// Ends the caller's own link and every Access Grant it currently supports in
// one batch (`endLinkStatements`, shared with the board's
// `/api/admin/person-links` unlink action), including the same
// last-System-Administrator refusal recorded as a denied Access Event.

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const db = getDb(env);
  const [link] = await db
    .select()
    .from(personLinks)
    .where(
      and(eq(personLinks.accountId, ctx.userId), isNull(personLinks.endedAt)),
    )
    .limit(1);
  // Own state, not an oracle: this tells the caller nothing about anyone
  // else's link.
  if (!link) return new Response('No linked person', { status: 409 });

  const nowMs = Date.now();
  if (
    await denyIfLastSystemAdministrator({
      database: env.DATABASE,
      accountId: ctx.userId,
      actorAccountId: ctx.userId,
      nowMs,
      operationKey: operationKey('verify-unlink', 'lastAdministratorDenied'),
    })
  )
    return new Response('Cannot unlink the last System Administrator', {
      status: 409,
    });

  const statements = await endLinkStatements({
    database: env.DATABASE,
    linkId: link.id,
    accountId: ctx.userId,
    actorAccountId: ctx.userId,
    endReason: 'self_unlink',
    nowMs,
    operationKey: operationKey('verify-unlink', 'unlink'),
  });
  let results: D1Result[];
  try {
    results = await env.DATABASE.batch(statements);
  } catch (error) {
    // A grant created concurrently with this unlink would have been ended
    // without its caused Access Event; the batch assertion makes that race
    // lose the whole command instead.
    if (isBatchAssertionError(error))
      return new Response('Access changed concurrently — try again', {
        status: 409,
      });
    throw error;
  }
  if (results[0].meta.changes !== 1) {
    if (
      await denyIfLastSystemAdministrator({
        database: env.DATABASE,
        accountId: ctx.userId,
        actorAccountId: ctx.userId,
        nowMs: Date.now(),
        operationKey: operationKey('verify-unlink', 'lastAdministratorDenied'),
      })
    )
      return new Response('Cannot unlink the last System Administrator', {
        status: 409,
      });
    return new Response('Link is no longer unlinkable', { status: 409 });
  }
  return new Response(null, { status: 204 });
};
