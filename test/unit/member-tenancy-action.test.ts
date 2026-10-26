import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimTenancy, tenancyAction } from '../../src/lib/member';

// #294 slice 4: the member tenancy routes answer some refusals as JSON
// `{ reason, message }` (a refused re-invite or claim) and others as plain
// text. The page shows the error, so it must be the message, never the JSON.

afterEach(() => vi.unstubAllGlobals());

function answer(body: string, status: number, type = 'text/plain') {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status, headers: { 'content-type': type } }),
      ),
  );
}

describe('tenancyAction', () => {
  it("shows a JSON refusal's message, not its JSON", async () => {
    answer(
      JSON.stringify({ reason: 'no-contact', message: 'Contact the board.' }),
      409,
      'application/json',
    );
    await expect(
      tenancyAction({ action: 'reinvite', tenancyId: 't' }),
    ).rejects.toThrow(/^Contact the board\.$/);
  });

  it('shows a plain-text refusal as it is', async () => {
    answer('Not found', 404);
    await expect(
      tenancyAction({ action: 'end', tenancyId: 't' }),
    ).rejects.toThrow(/^Not found$/);
  });
});

describe('claimTenancy', () => {
  it("shows a JSON refusal's message", async () => {
    answer(
      JSON.stringify({ ok: false, reason: 'person-linked', message: 'Ask.' }),
      409,
      'application/json',
    );
    await expect(claimTenancy('x')).rejects.toThrow(/^Ask\.$/);
  });

  it('falls back to the status for an empty body', async () => {
    answer('', 502);
    await expect(claimTenancy('x')).rejects.toThrow(/502/);
  });
});
