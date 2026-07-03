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
