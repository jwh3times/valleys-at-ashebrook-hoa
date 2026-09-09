import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * The uniform response on `/api/verify/request` is a security boundary, and
 * timing is part of it: a matched address and name used to pay for a Resend or
 * Twilio call plus several KV writes before answering, while an unmatched
 * address returned after a few D1 reads and a rate-limited caller returned
 * fastest of all. Latency alone therefore told an attacker which outcome they
 * had hit — the oracle the identical body exists to close.
 *
 * The route now hands every bit of that work to `waitUntil`, so the response
 * is produced at the same point on every path. This file proves it the only
 * way that is not a stopwatch: the sender NEVER resolves, and the handler
 * still answers.
 */

/**
 * A latch that works in either order: the deferred work may reach the sender
 * long after the handler has answered and the test has already released, so
 * releasing first must make later sends resolve immediately rather than hang
 * forever.
 */
const senderGate = vi.hoisted(() => {
  const state = {
    released: false,
    waiting: [] as (() => void)[],
    started: { email: false },
  };
  return {
    started: state.started,
    /** A send that never settles until the test lets it. */
    hang: () =>
      state.released
        ? Promise.resolve()
        : new Promise<void>((resolve) => state.waiting.push(resolve)),
    releaseAll: () => {
      state.released = true;
      for (const resolve of state.waiting.splice(0)) resolve();
    },
  };
});

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('tmuser', 'homeowner', []),
}));
vi.mock('../../src/server/authz/turnstile', () => ({
  verifyTurnstile: async () => true,
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn(() => {
    senderGate.started.email = true;
    return senderGate.hang();
  }),
  sendSms: vi.fn(() => senderGate.hang()),
}));

import {
  POST,
  UNIFORM_REQUEST_RESPONSE,
} from '../../src/pages/api/verify/request';
import { getDb } from '../../src/server/db/client';
import { properties, owners, users } from '../../src/server/db/schema';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  const db = getDb(env);
  await db.insert(properties).values({
    id: 'tm-prop',
    address: '9 Timing Way',
    addressNormalized: '9 timing way',
    unit: null,
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(users).values({
    id: 'tmuser',
    name: 'Timing User',
    email: 'timing-user@example.test',
    emailVerified: true,
    role: 'homeowner',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(owners).values({
    id: 'tm-own',
    propertyId: 'tm-prop',
    fullName: 'Timing Owner',
    phone: null,
    email: 'timing-owner@example.test',
    status: 'active',
    notes: null,
    createdAt: now,
    updatedAt: now,
  });
});

/** The deferred work the handler hands to the runtime, captured rather than
 * awaited — exactly what the Worker's ExecutionContext does with it. */
function reqWithExecutionContext(deferred: Promise<unknown>[]) {
  return POST({
    request: new Request('http://localhost/api/verify/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: '9 Timing Way',
        name: 'Timing Owner',
        channel: 'email',
        turnstileToken: 't',
      }),
    }),
    locals: {
      cfContext: {
        waitUntil: (p: Promise<unknown>) => deferred.push(p),
        passThroughOnException: () => {},
        props: {},
      },
    },
  } as never);
}

describe('verify request timing', () => {
  it('answers without waiting for the send to finish', async () => {
    const deferred: Promise<unknown>[] = [];

    // If the handler awaited the roster work, this would never settle.
    const res = await reqWithExecutionContext(deferred);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify(UNIFORM_REQUEST_RESPONSE));

    // Handed to the runtime rather than skipped: the work is still in flight,
    // and it does reach the sender once let through.
    expect(deferred).toHaveLength(1);
    senderGate.releaseAll();
    await Promise.all(deferred);
    expect(senderGate.started.email).toBe(true);
  });
});
