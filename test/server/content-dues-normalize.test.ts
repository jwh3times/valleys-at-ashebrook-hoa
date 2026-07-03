import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from '../../src/pages/api/content/dues';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('GET /api/content/dues normalization', () => {
  it('strips unknown keys and non-http(s) payment urls from a mangled stored blob', async () => {
    const now = new Date();
    await getDb(env)
      .insert(settings)
      .values({
        key: 'dues',
        value: JSON.stringify({
          amount: '$250',
          dueDate: 'Jan 31',
          notes: 'late fee $25',
          evil: '<script>',
          paymentOptions: [
            { label: 'X', details: 'y', url: 'javascript:alert(1)' },
          ],
        }),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: JSON.stringify({ amount: '$250' }), updatedAt: now },
      });

    const res = await GET({} as never);
    const body = (await res.json()) as {
      amount: string;
      paymentOptions: { url?: string }[];
      evil?: unknown;
    };
    expect(body.amount).toBe('$250');
    expect('evil' in body).toBe(false);
    expect(body.paymentOptions[0].url).toBeUndefined();
  });
});
