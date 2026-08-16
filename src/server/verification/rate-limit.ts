// Abuse throttle for /api/verify/request, which fans real SMS/email to every
// owner contact on a home. Counting property_verifications rows is unreliable
// (each request deletes the caller's prior unconsumed code), so use KV counters.
// Read-modify-write on KV is not atomic; at HOA request volumes the small race
// is acceptable and the cooldown blocks bursts regardless.

const COOLDOWN_SECONDS = 120; // 1 request / 2 min per user
export const DAILY_LIMIT = 5; // per user AND per property, rolling ~24h
const DAY_SECONDS = 86_400;

async function count(env: Env, key: string): Promise<number> {
  return Number((await env.KV.get(key)) ?? '0');
}

export async function checkUserRateLimit(
  env: Env,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: 'cooldown' | 'daily' }> {
  if (await env.KV.get(`verif:cooldown:${userId}`))
    return { ok: false, reason: 'cooldown' };
  if ((await count(env, `verif:day:user:${userId}`)) >= DAILY_LIMIT)
    return { ok: false, reason: 'daily' };
  return { ok: true };
}

export async function checkPropertyRateLimit(
  env: Env,
  propertyId: string,
): Promise<{ ok: true } | { ok: false; reason: 'daily' }> {
  if ((await count(env, `verif:day:prop:${propertyId}`)) >= DAILY_LIMIT)
    return { ok: false, reason: 'daily' };
  return { ok: true };
}

export async function setCooldown(env: Env, userId: string): Promise<void> {
  await env.KV.put(`verif:cooldown:${userId}`, '1', {
    expirationTtl: COOLDOWN_SECONDS,
  });
}

export async function recordVerificationSend(
  env: Env,
  userId: string,
  propertyId: string,
): Promise<void> {
  const userKey = `verif:day:user:${userId}`;
  const propKey = `verif:day:prop:${propertyId}`;
  await env.KV.put(userKey, String((await count(env, userKey)) + 1), {
    expirationTtl: DAY_SECONDS,
  });
  await env.KV.put(propKey, String((await count(env, propKey)) + 1), {
    expirationTtl: DAY_SECONDS,
  });
}

// ADR 0022 phase 3c (#219) additions — the derived-mode Person matcher's
// abuse throttles. Same KV-counter approach as above, for the same reason:
// D1 round trips are not worth spending on a soft, best-effort cap.

/** Per-Person daily cap on Automatic Person Verification sends (derived mode
 * only — legacy has no Person). Distinct from the per-account and per-Lot
 * caps: a Person who owns several Lots must not be re-sendable once per Lot. */
export async function checkPersonRateLimit(
  env: Env,
  partyId: string,
): Promise<{ ok: true } | { ok: false; reason: 'daily' }> {
  if ((await count(env, `verif:day:person:${partyId}`)) >= DAILY_LIMIT)
    return { ok: false, reason: 'daily' };
  return { ok: true };
}

export async function recordPersonSend(
  env: Env,
  partyId: string,
): Promise<void> {
  const key = `verif:day:person:${partyId}`;
  await env.KV.put(key, String((await count(env, key)) + 1), {
    expirationTtl: DAY_SECONDS,
  });
}

/** The distinct-claimed-names-per-Lot-per-account cap (both modes): the
 * roster-walking control. An applicant who tries more than three different
 * normalized names against one Lot from one account is capped, independent of
 * whether any of those names actually matched a current owner — the cap is on
 * probing, not on match failures. */
const CLAIMED_NAME_CAP = 3;

function claimedNamesKey(lotId: string, accountId: string): string {
  return `verif:names:${lotId}:${accountId}`;
}

async function claimedNames(
  env: Env,
  lotId: string,
  accountId: string,
): Promise<string[]> {
  const raw = await env.KV.get(claimedNamesKey(lotId, accountId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function checkClaimedNames(
  env: Env,
  lotId: string,
  accountId: string,
  normalizedName: string,
): Promise<{ ok: true } | { ok: false; reason: 'distinctNames' }> {
  const names = await claimedNames(env, lotId, accountId);
  if (names.includes(normalizedName)) return { ok: true };
  if (names.length >= CLAIMED_NAME_CAP)
    return { ok: false, reason: 'distinctNames' };
  return { ok: true };
}

export async function recordClaimedName(
  env: Env,
  lotId: string,
  accountId: string,
  normalizedName: string,
): Promise<void> {
  const names = await claimedNames(env, lotId, accountId);
  if (!names.includes(normalizedName)) names.push(normalizedName);
  await env.KV.put(claimedNamesKey(lotId, accountId), JSON.stringify(names), {
    expirationTtl: DAY_SECONDS,
  });
}
