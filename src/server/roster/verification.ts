import { and, desc, eq, isNull, sql as dsql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  verificationCodes,
  verificationReviewRequests,
} from '../db/roster-schema';
import { normalizeAddress, normalizeName } from './normalize';
import { sendEmail, sendSms } from '../auth/senders';
import { SITE_NAME } from '../../lib/site';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
  CODE_TTL_MS,
} from '../verification/codes';
import {
  checkPropertyRateLimit,
  recordVerificationSend,
  checkPersonRateLimit,
  recordPersonSend,
  checkClaimedNames,
  recordClaimedName,
} from '../verification/rate-limit';
import { AuditCorrelation, operationKey, type SqlGuard } from './audit';

// ADR 0022 phase 3c (#219): the DERIVED backend for /api/verify/request +
// confirm. Mirrors `derive.ts`'s currency and one-hop-consolidation SQL
// exactly rather than inventing a second copy of "what counts as a current
// owner" (see that module's header comment for why nothing here is cached and
// evaluation never trusts the write path).
//
// The whole flow is one converging funnel: every internal outcome — lot not
// found, name unmatched or ambiguous, no uniquely attributable contact, a
// rate limit, an already-linked collision — is reported as a distinct `kind`
// here so tests can assert on it directly, but `POST /api/verify/request`
// (the caller) maps every one of them to the SAME uniform response (D2). This
// module never decides what the caller sees; it only ever reports what
// happened internally.

// ---------------------------------------------------------------------------
// Person matching (D3)
// ---------------------------------------------------------------------------

interface OwnerRow {
  partyId: string;
  nameNormalized: string | null;
}

interface LotRow {
  id: string;
}

interface ContactRow {
  id: string;
  value: string | null;
  valueNormalized: string | null;
}

/** The claimed Lot: active, not retired, matched by normalized address. */
async function findLot(env: Env, address: string): Promise<LotRow | null> {
  const norm = normalizeAddress(address);
  const row = await env.DATABASE.prepare(
    `SELECT id FROM properties
     WHERE address_normalized = ? AND status = 'active' AND retired_at IS NULL
     LIMIT 1`,
  )
    .bind(norm)
    .first<LotRow>();
  return row ?? null;
}

/**
 * Current Person owners of the Lot, one-hop-consolidated exactly like
 * `derive.ts`'s `me` CTE (a Party merged into a survivor resolves to the
 * survivor). An Organization owner never appears here: the join through
 * `people` only resolves a Party whose kind is `person`, which is what makes
 * an organization-owned Lot fail to match by construction, not by a separate
 * check.
 */
async function fetchPersonOwners(
  env: Env,
  lotId: string,
  associationDay: string,
): Promise<OwnerRow[]> {
  const result = await env.DATABASE.prepare(
    `SELECT DISTINCT pe.party_id AS partyId, pe.name_normalized AS nameNormalized
     FROM ownerships o
     JOIN parties pa ON pa.id = o.owner_party_id
     JOIN people pe ON pe.party_id = COALESCE(pa.consolidated_into_party_id, pa.id)
     WHERE o.lot_id = ?
       AND o.voided_at IS NULL
       AND (o.start_day IS NULL OR o.start_day <= ?)
       AND (o.end_day IS NULL OR ? < o.end_day)`,
  )
    .bind(lotId, associationDay, associationDay)
    .all<OwnerRow>();
  return result.results;
}

/**
 * Two-tier name match (#201): tier 1 is an exact normalized full-string
 * match; tier 2 (only tried when tier 1 matches zero) requires the first AND
 * last normalized tokens to agree. Either tier requires EXACTLY one
 * candidate — two or more is ambiguous and fails, with no fallback from an
 * ambiguous tier 1 to tier 2. No edit distance, no nickname table.
 */
function matchOwnerName(
  owners: OwnerRow[],
  normalizedInput: string,
): OwnerRow | null {
  const tier1 = owners.filter((o) => o.nameNormalized === normalizedInput);
  if (tier1.length === 1) return tier1[0];
  if (tier1.length >= 2) return null;

  const parts = normalizedInput.split(' ').filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const tier2 = owners.filter((o) => {
    if (!o.nameNormalized) return false;
    const ownerParts = o.nameNormalized.split(' ').filter(Boolean);
    if (ownerParts.length === 0) return false;
    return (
      ownerParts[0] === first && ownerParts[ownerParts.length - 1] === last
    );
  });
  return tier2.length === 1 ? tier2[0] : null;
}

/**
 * The matched Person's current, unvoided, unredacted contact on the chosen
 * channel — preferred first — that is ALSO uniquely attributable roster-wide:
 * its (channel, value_normalized) pair must resolve to exactly one Party
 * among current/unvoided/unredacted rows. A household value shared by two
 * Parties disqualifies both, so the loop tries the next candidate rather than
 * stopping at the first row.
 */
async function pickUniqueContact(
  env: Env,
  associationDay: string,
  personPartyId: string,
  channel: 'email' | 'sms',
): Promise<{ id: string; value: string } | null> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, value, value_normalized AS valueNormalized
     FROM contact_methods
     WHERE party_id = ?
       AND party_kind = 'person'
       AND channel = ?
       AND voided_at IS NULL
       AND redacted_at IS NULL
       AND (start_day IS NULL OR start_day <= ?)
       AND (end_day IS NULL OR ? < end_day)
     ORDER BY is_preferred DESC`,
  )
    .bind(personPartyId, channel, associationDay, associationDay)
    .all<ContactRow>();

  for (const row of rows.results) {
    if (!row.value || !row.valueNormalized) continue;
    const uniq = await env.DATABASE.prepare(
      `SELECT COUNT(DISTINCT party_id) AS cnt
       FROM contact_methods
       WHERE channel = ?
         AND value_normalized = ?
         AND voided_at IS NULL
         AND redacted_at IS NULL
         AND (start_day IS NULL OR start_day <= ?)
         AND (end_day IS NULL OR ? < end_day)`,
    )
      .bind(channel, row.valueNormalized, associationDay, associationDay)
      .first<{ cnt: number }>();
    if (uniq && uniq.cnt === 1) return { id: row.id, value: row.value };
  }
  return null;
}

async function hasCurrentLink(env: Env, accountId: string): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 FROM person_links WHERE account_id = ? AND ended_at IS NULL LIMIT 1`,
  )
    .bind(accountId)
    .first();
  return row !== null;
}

async function personLinkedToOtherAccount(
  env: Env,
  personId: string,
  accountId: string,
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 FROM person_links WHERE person_id = ? AND ended_at IS NULL AND account_id <> ? LIMIT 1`,
  )
    .bind(personId, accountId)
    .first();
  return row !== null;
}

/** Idempotent under `verification_review_requests_open_unq` — a second
 * collision for an account that already has an open review request is a
 * silent no-op, never a second row. */
async function createReviewRequest(
  env: Env,
  opts: {
    accountId: string;
    address: string;
    name: string;
    channel: 'email' | 'sms';
    internalReason: 'applicant_requested' | 'person_already_linked';
  },
): Promise<void> {
  await getDb(env)
    .insert(verificationReviewRequests)
    .values({
      id: crypto.randomUUID(),
      accountId: opts.accountId,
      // Same 200-char cap the explicit /api/verify/review action applies —
      // the collision path must not be a loophole for unbounded free text.
      claimedAddress: opts.address.slice(0, 200),
      claimedName: opts.name.slice(0, 200),
      channel: opts.channel,
      internalReason: opts.internalReason,
      status: 'open',
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

export type PersonMatchResult =
  | { kind: 'lot_not_found' }
  | { kind: 'rate_limited' }
  | { kind: 'name_unmatched' }
  | { kind: 'no_contact' }
  | { kind: 'account_already_linked' }
  | { kind: 'person_already_linked' }
  | {
      kind: 'matched';
      lotId: string;
      personId: string;
      contactMethodId: string;
      contactValue: string;
    };

/**
 * Runs the whole derived-mode match: Lot resolution, the D11 abuse throttles
 * in their specified order (per-Lot daily, distinct-claimed-names, per-Person
 * daily after a match), the two-tier name match, uniquely-attributable
 * contact selection, and the two request-time collision checks (D3 step 5).
 * Never sends anything and never writes a pending code — `requestPersonVerification`
 * below does that only on a `matched` result.
 */
export async function matchPersonForVerification(
  env: Env,
  associationDay: string,
  accountId: string,
  address: string,
  name: string,
  channel: 'email' | 'sms',
): Promise<PersonMatchResult> {
  const lot = await findLot(env, address);
  if (!lot) return { kind: 'lot_not_found' };

  const lotRl = await checkPropertyRateLimit(env, lot.id);
  if (!lotRl.ok) return { kind: 'rate_limited' };

  const normalizedName = normalizeName(name);
  if (!normalizedName) return { kind: 'name_unmatched' };

  const namesRl = await checkClaimedNames(
    env,
    lot.id,
    accountId,
    normalizedName,
  );
  if (!namesRl.ok) return { kind: 'rate_limited' };
  await recordClaimedName(env, lot.id, accountId, normalizedName);

  const owners = await fetchPersonOwners(env, lot.id, associationDay);
  const matched = matchOwnerName(owners, normalizedName);
  if (!matched) return { kind: 'name_unmatched' };

  const personRl = await checkPersonRateLimit(env, matched.partyId);
  if (!personRl.ok) return { kind: 'rate_limited' };

  const contact = await pickUniqueContact(
    env,
    associationDay,
    matched.partyId,
    channel,
  );
  if (!contact) return { kind: 'no_contact' };

  if (await hasCurrentLink(env, accountId)) {
    return { kind: 'account_already_linked' };
  }
  if (await personLinkedToOtherAccount(env, matched.partyId, accountId)) {
    await createReviewRequest(env, {
      accountId,
      address,
      name,
      channel,
      internalReason: 'person_already_linked',
    });
    return { kind: 'person_already_linked' };
  }

  return {
    kind: 'matched',
    lotId: lot.id,
    personId: matched.partyId,
    contactMethodId: contact.id,
    contactValue: contact.value,
  };
}

export type PersonVerificationRequestResult =
  PersonMatchResult | { kind: 'send_failed' } | { kind: 'sent' };

/**
 * The full derived-mode request flow: match, then — on a match — write a
 * pending `verification_codes` row and send exactly ONE message to the
 * matched contact. `/api/verify/request` maps every result here to the
 * uniform response (D2); nothing here ever returns a distinguishable status
 * to the caller.
 */
export async function requestPersonVerification(
  env: Env,
  associationDay: string,
  accountId: string,
  address: string,
  name: string,
  channel: 'email' | 'sms',
): Promise<PersonVerificationRequestResult> {
  const match = await matchPersonForVerification(
    env,
    associationDay,
    accountId,
    address,
    name,
    channel,
  );
  if (match.kind !== 'matched') return match;

  const db = getDb(env);
  // A fresh request replaces any prior unconsumed code for this account —
  // same rule the legacy backend already applies.
  await db
    .delete(verificationCodes)
    .where(
      and(
        eq(verificationCodes.accountId, accountId),
        isNull(verificationCodes.consumedAt),
      ),
    );

  const now = new Date();
  const code = generateCode();
  await db.insert(verificationCodes).values({
    id: crypto.randomUUID(),
    accountId,
    personId: match.personId,
    contactMethodId: match.contactMethodId,
    lotId: match.lotId,
    channel,
    codeHash: await hashCode(code, env.BETTER_AUTH_SECRET),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    attempts: 0,
    consumedAt: null,
    createdAt: now,
  });

  const message = `Your Valleys at Ashebrook verification code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this message.`;
  const subject = `Your verification code — ${SITE_NAME}`;
  try {
    if (channel === 'email') {
      await sendEmail(env, match.contactValue, subject, message);
    } else {
      await sendSms(env, match.contactValue, message);
    }
  } catch {
    return { kind: 'send_failed' };
  }

  await recordVerificationSend(env, accountId, match.lotId);
  await recordPersonSend(env, match.personId);
  return { kind: 'sent' };
}

// ---------------------------------------------------------------------------
// Confirm (D5) — one batch
// ---------------------------------------------------------------------------

export async function confirmPersonVerification(
  env: Env,
  accountId: string,
  code: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'locked' | 'mismatch' }> {
  const db = getDb(env);
  const [row] = await db
    .select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.accountId, accountId),
        isNull(verificationCodes.consumedAt),
      ),
    )
    .orderBy(desc(verificationCodes.createdAt));
  if (!row) return { ok: false, reason: 'mismatch' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (row.expiresAt.getTime() < Date.now())
    return { ok: false, reason: 'expired' };
  if (!(await verifyCode(code, row.codeHash, env.BETTER_AUTH_SECRET))) {
    await db
      .update(verificationCodes)
      .set({ attempts: dsql`${verificationCodes.attempts} + 1` })
      .where(eq(verificationCodes.id, row.id));
    return { ok: false, reason: 'mismatch' };
  }

  const nowMs = Date.now();
  const verificationId = crypto.randomUUID();
  const linkId = crypto.randomUUID();
  const method = row.channel === 'email' ? 'otp_email' : 'otp_sms';

  // The update-primary marker: the code row landed in ITS post-state, this
  // command's `consumed_at`. Re-checks attempts/expiry at the boundary too,
  // even though both were already checked above — the mutation-boundary
  // re-check convention this repo practices everywhere else.
  const primary = env.DATABASE.prepare(
    `UPDATE verification_codes
     SET consumed_at = ?
     WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at > ?`,
  ).bind(nowMs, row.id, MAX_ATTEMPTS, nowMs);

  const primaryGuard: SqlGuard = {
    sql: 'EXISTS (SELECT 1 FROM verification_codes WHERE id = ? AND consumed_at = ?)',
    binds: [row.id, nowMs],
  };

  const insertVerification = env.DATABASE.prepare(
    `INSERT INTO person_verifications (id, account_id, person_id, method, contact_method_id, contact_method_party_kind, reason, verified_at)
     SELECT ?, ?, ?, ?, ?, 'person', 'automatic_contact_proof', ?
     WHERE ${primaryGuard.sql}`,
  ).bind(
    verificationId,
    accountId,
    row.personId,
    method,
    row.contactMethodId,
    nowMs,
    ...primaryGuard.binds,
  );

  const verificationGuard: SqlGuard = {
    sql: 'EXISTS (SELECT 1 FROM person_verifications WHERE id = ?)',
    binds: [verificationId],
  };

  // The partial unique indexes on `person_links` (one current link per
  // account, one per Person) are the structural collision guard: a race with
  // another link for this account or this Person errors the whole batch,
  // which the caller catches and reports as the same generic failure — zero
  // rows anywhere, per #219/D5.
  const insertLink = env.DATABASE.prepare(
    `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
     SELECT ?, ?, ?, ?, ?
     WHERE ${primaryGuard.sql} AND ${verificationGuard.sql}`,
  ).bind(
    linkId,
    accountId,
    row.personId,
    verificationId,
    nowMs,
    ...primaryGuard.binds,
    ...verificationGuard.binds,
  );

  const linkGuard: SqlGuard = {
    sql: 'EXISTS (SELECT 1 FROM person_links WHERE id = ?)',
    binds: [linkId],
  };

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('verify-confirm', 'person_verified'),
    actorAccountId: accountId,
    nowMs,
  });
  correlation.event({
    kind: 'person_verified',
    guard: linkGuard,
    detail: {
      family: 'identity',
      reason: 'automatic_contact_proof',
      personVerificationId: verificationId,
      personLinkId: linkId,
      personId: row.personId,
      targetAccountId: accountId,
    },
  });

  // Write-behind mirrors (#221's pattern): never read for authorization,
  // kept only so the legacy read model and Better Auth session stay coherent
  // through the flip. Both are gated on the SAME primary marker as the
  // domain rows above, so a lost race leaves neither behind either.
  const mirrorLink = env.DATABASE.prepare(
    `INSERT INTO user_property_links (id, user_id, property_id, verified_at, method)
     SELECT ?, ?, ?, ?, ?
     WHERE ${primaryGuard.sql} AND NOT EXISTS (
       SELECT 1 FROM user_property_links WHERE user_id = ? AND property_id = ?
     )`,
  ).bind(
    crypto.randomUUID(),
    accountId,
    row.lotId,
    Math.floor(nowMs / 1000),
    method,
    ...primaryGuard.binds,
    accountId,
    row.lotId,
  );

  const mirrorRole = env.DATABASE.prepare(
    `UPDATE users SET role = 'homeowner'
     WHERE id = ? AND role = 'visitor' AND ${primaryGuard.sql}`,
  ).bind(accountId, ...primaryGuard.binds);

  try {
    const results = await env.DATABASE.batch([
      primary,
      insertVerification,
      insertLink,
      ...correlation.statements,
      mirrorLink,
      mirrorRole,
    ]);
    if (results[0].meta.changes !== 1) return { ok: false, reason: 'mismatch' };
    return { ok: true };
  } catch {
    // A person_links unique-index collision (or any other batch failure)
    // lands here. Never distinguishable from an ordinary mismatch — confirm
    // is not a roster oracle either.
    return { ok: false, reason: 'mismatch' };
  }
}
