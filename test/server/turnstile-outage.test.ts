import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyTurnstile } from '../../src/server/authz/turnstile';

/**
 * A Turnstile outage is an UNVERIFIED token, not a server error.
 *
 * `verifyTurnstile` used to let a network failure or a non-JSON body throw
 * straight out of `res.json()`, which surfaced as a 500 from callers whose
 * contract is a 400 for a bad captcha — so an outage at Cloudflare turned every
 * gated form into an error page rather than a retry prompt.
 */

const request = new Request('http://localhost/api/verify/request', {
  method: 'POST',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verifyTurnstile when siteverify misbehaves', () => {
  it('returns false when the request fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network unreachable')),
    );
    expect(await verifyTurnstile(env, 'a-token', request)).toBe(false);
  });

  it('returns false when the response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502</html>')),
    );
    expect(await verifyTurnstile(env, 'a-token', request)).toBe(false);
  });

  it('returns false when the body has no success field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ 'error-codes': ['x'] })),
    );
    expect(await verifyTurnstile(env, 'a-token', request)).toBe(false);
  });

  it('still returns true for a genuinely valid token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ success: true })),
    );
    expect(await verifyTurnstile(env, 'a-token', request)).toBe(true);
  });

  it('treats a non-boolean success as failure', async () => {
    // The old code returned `data.success` verbatim, so a string "true" was
    // truthy at every call site.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ success: 'true' })),
    );
    expect(await verifyTurnstile(env, 'a-token', request)).toBe(false);
  });
});
