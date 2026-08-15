import { and, eq, isNull } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb, type Db } from '../db/client';
import {
  parties,
  personLinks,
  systemAdminBootstrap,
} from '../db/roster-schema';
import { timingSafeEqual } from '../authz/timing-safe';
import { readJson, stringField } from '../http';
import {
  AuditCorrelation,
  operationKey,
  insertedRowGuard,
  assertInBatch,
  isBatchAssertionError,
  type SqlGuard,
} from './audit';

/**
 * Fail-closed first-System-Administrator bootstrap (#201's amendment, #219).
 *
 * Replaces the retired `seedBoard`/`handleBootstrapBoard` pair in
 * `src/server/auth/seed-board.ts`, which signed up a brand-new BOARD_EMAIL/
 * BOARD_PASSWORD account directly against `users.role`. That path is gone:
 * bootstrap now LINKS an already-signed-in account to an already-recorded
 * Person, escaping the identity circularity rather than routing around it —
 * the same operation `/api/admin/person-links`'s `manualVerify` performs,
 * except this is the one time it may create the roster's first System
 * Administrator with no board admin yet in place to approve it.
 *
 * Four independent guards, all required, checked IN THIS ORDER:
 *
 *  1. Self-disabling — refuse with 410 the moment the singleton has been
 *     consumed. This is the PRIMARY guard: unlike the legacy version, it is
 *     not "does a board account exist" (an account can be promoted board by
 *     other means) but "has bootstrap itself already run".
 *  2. Secret — constant-time match of `x-bootstrap-secret` against
 *     `env.BOOTSTRAP_SECRET`; a missing binding is treated as closed (403),
 *     never as "unset means open".
 *  3. Session — the caller must already be signed in (401). Resolved
 *     directly from the Better Auth session rather than through
 *     `getAuthContext`/`cutover_mode`: bootstrap runs at flip step 4 while
 *     `cutover_mode` may still read `legacy`, and its own outcome (creating
 *     the account's Person Link) must not depend on which model happens to
 *     be answering at that moment.
 *  4. The operator names the Person to link (`{ personId }`). Readable
 *     404/409 pre-checks are safe here — the route sits behind the secret.
 *
 * The route path stays `/api/bootstrap/board` and is one of exactly two
 * `write-freeze.ts` exemptions: flip step 4 runs this WHILE the operator
 * write freeze is on, so this module never calls `writeFreezeError`.
 */

const ALREADY_USED = 'Bootstrap has already been used.';

async function preconditionResponse(
  db: Db,
  personId: string,
  accountId: string,
): Promise<Response | null> {
  const [consumed] = await db
    .select({ key: systemAdminBootstrap.singletonKey })
    .from(systemAdminBootstrap)
    .limit(1);
  if (consumed) return new Response(ALREADY_USED, { status: 410 });

  const [party] = await db
    .select({
      id: parties.id,
      kind: parties.kind,
      consolidatedIntoPartyId: parties.consolidatedIntoPartyId,
    })
    .from(parties)
    .where(eq(parties.id, personId))
    .limit(1);
  if (!party) return new Response('Unknown person', { status: 404 });
  if (party.kind !== 'person')
    return new Response('That party is an organization, not a Person', {
      status: 409,
    });
  if (party.consolidatedIntoPartyId !== null)
    return new Response(
      'Person has been consolidated — bootstrap into the survivor',
      { status: 409 },
    );

  const [personLinked] = await db
    .select({ id: personLinks.id })
    .from(personLinks)
    .where(and(eq(personLinks.personId, personId), isNull(personLinks.endedAt)))
    .limit(1);
  if (personLinked)
    return new Response('Person is already linked to an account', {
      status: 409,
    });

  const [accountLinked] = await db
    .select({ id: personLinks.id })
    .from(personLinks)
    .where(
      and(eq(personLinks.accountId, accountId), isNull(personLinks.endedAt)),
    )
    .limit(1);
  if (accountLinked)
    return new Response('This account is already linked to a Person', {
      status: 409,
    });

  return null;
}

export async function handleBootstrapBoard(
  env: Env,
  request: Request,
): Promise<Response> {
  const db = getDb(env);

  // 1. Primary guard: permanently inert once the singleton is consumed.
  const [consumed] = await db
    .select({ key: systemAdminBootstrap.singletonKey })
    .from(systemAdminBootstrap)
    .limit(1);
  if (consumed) return new Response(ALREADY_USED, { status: 410 });

  // 2. Secret gate (fail-closed).
  const provided = request.headers.get('x-bootstrap-secret');
  if (
    !env.BOOTSTRAP_SECRET ||
    !provided ||
    !timingSafeEqual(provided, env.BOOTSTRAP_SECRET)
  )
    return new Response('Forbidden', { status: 403 });

  // 3. Session gate. Read directly off Better Auth — never through
  // `getAuthContext`/`cutover_mode` (see the module comment above).
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });
  const accountId = session.user.id;

  // 4. Body { personId }.
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const personId = stringField(parsed.value, 'personId');
  if (!personId) return new Response('personId is required', { status: 400 });

  const pre = await preconditionResponse(db, personId, accountId);
  if (pre) return pre;

  const verificationId = crypto.randomUUID();
  const linkId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const nowMs = Date.now();

  // Every precondition re-checked at the mutation boundary: the singleton
  // still absent, the Person still exists/unconsolidated, and neither side
  // of the Link already current. This INSERT is the command's PRIMARY —
  // `meta.changes` on it decides success.
  const verificationPrimary = env.DATABASE.prepare(
    `INSERT INTO person_verifications (id, account_id, person_id, method, contact_method_id, contact_method_party_kind, approver_account_id, reason, verified_at)
     SELECT ?, ?, ?, 'bootstrap', NULL, NULL, NULL, 'bootstrap_first_administrator', ?
     WHERE NOT EXISTS (SELECT 1 FROM system_admin_bootstrap)
       AND EXISTS (
         SELECT 1 FROM people p
         JOIN parties pt ON pt.id = p.party_id
         WHERE p.party_id = ? AND pt.kind = 'person' AND pt.consolidated_into_party_id IS NULL
       )
       AND NOT EXISTS (SELECT 1 FROM person_links WHERE person_id = ? AND ended_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM person_links WHERE account_id = ? AND ended_at IS NULL)`,
  ).bind(
    verificationId,
    accountId,
    personId,
    nowMs,
    personId,
    personId,
    accountId,
  );

  const verificationLanded = insertedRowGuard(
    'person_verifications',
    verificationId,
  );
  const linkPrimary = env.DATABASE.prepare(
    `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
     SELECT ?, ?, ?, ?, ?
     WHERE ${verificationLanded.sql}`,
  ).bind(
    linkId,
    accountId,
    personId,
    verificationId,
    nowMs,
    ...verificationLanded.binds,
  );

  const linkLanded = insertedRowGuard('person_links', linkId);
  const grantPrimary = env.DATABASE.prepare(
    `INSERT INTO access_grants (id, account_id, grant_type, qualifying_board_term_id, started_at, granted_by_account_id, grant_reason)
     SELECT ?, ?, 'system_admin', NULL, ?, ?, 'bootstrap'
     WHERE ${linkLanded.sql}`,
  ).bind(grantId, accountId, nowMs, accountId, ...linkLanded.binds);

  const grantLanded = insertedRowGuard('access_grants', grantId);
  const singletonPrimary = env.DATABASE.prepare(
    `INSERT INTO system_admin_bootstrap (singleton_key, consumed_at, account_id, access_grant_id)
     SELECT 'singleton', ?, ?, ?
     WHERE ${grantLanded.sql}`,
  ).bind(nowMs, accountId, grantId, ...grantLanded.binds);

  // NOTE: every downstream guard below is scoped to THIS command's own
  // freshly generated `grantId` (`grantLanded`), never to the shared
  // `system_admin_bootstrap` singleton by itself. The singleton table has
  // exactly one row, so "does a singleton row exist" cannot tell one
  // command's success apart from another's — a batch that lost the race (its
  // own `verificationPrimary` found the singleton already taken and inserted
  // nothing) would otherwise see the WINNER's singleton and try to write a
  // root Identity Event and role-mirror update that dangle off ITS OWN
  // never-inserted verification/link/grant rows, which fails a foreign key
  // rather than cleanly no-op'ing. `grantLanded` is per-command unique (a
  // fresh UUID each call) and can only be true when this command's own chain
  // — verification, then link, then grant — actually landed.
  const roleMirror = env.DATABASE.prepare(
    `UPDATE users SET role = 'board', updated_at = ?
     WHERE id = ? AND ${grantLanded.sql}`,
  ).bind(nowMs, accountId, ...grantLanded.binds);

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('bootstrap-board', 'bootstrap'),
    actorAccountId: accountId,
    nowMs,
    actorKind: 'bootstrap',
  });
  correlation.event({
    kind: 'person_verified',
    guard: grantLanded,
    detail: {
      family: 'identity',
      reason: 'bootstrap_first_administrator',
      personVerificationId: verificationId,
      personLinkId: linkId,
      personId,
      targetAccountId: accountId,
    },
  });
  correlation.event({
    kind: 'grant_created',
    guard: grantLanded,
    actor: { kind: 'automatic', cause: 'bootstrap' },
    detail: {
      family: 'access',
      grantId,
      targetAccountId: accountId,
      grantType: 'system_admin',
      requestedAction: 'bootstrap',
      outcome: 'allowed',
      reason: 'bootstrap',
    },
  });

  // Belt-and-suspenders atomicity check: the chained WHERE guards above
  // already make each insert a no-op once an earlier one failed to land, but
  // this converts any gap between "the verification landed" and "everything
  // else landed" into a hard rollback rather than a silently partial commit.
  const consistencyGuard: SqlGuard = {
    sql: `(NOT EXISTS (SELECT 1 FROM person_verifications WHERE id = ?) OR (
            EXISTS (SELECT 1 FROM person_links WHERE id = ?) AND
            EXISTS (SELECT 1 FROM access_grants WHERE id = ?) AND
            EXISTS (SELECT 1 FROM system_admin_bootstrap WHERE singleton_key = 'singleton')
          ))`,
    binds: [verificationId, linkId, grantId],
  };

  let results;
  try {
    results = await env.DATABASE.batch([
      verificationPrimary,
      linkPrimary,
      grantPrimary,
      singletonPrimary,
      roleMirror,
      ...correlation.statements,
      assertInBatch(env.DATABASE, consistencyGuard),
    ]);
  } catch (e) {
    if (isBatchAssertionError(e))
      return new Response('Bootstrap could not be completed atomically', {
        status: 409,
      });
    throw e;
  }

  if (results[0].meta.changes !== 1) {
    // Lost a race (most likely: another request consumed the singleton
    // first). Re-run the readable pre-checks to pick the right response.
    const retry = await preconditionResponse(getDb(env), personId, accountId);
    return retry ?? new Response(ALREADY_USED, { status: 410 });
  }

  return new Response(null, { status: 204 });
}
