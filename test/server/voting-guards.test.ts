import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireVotingApi } from '../../src/server/authz/voting-guards';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import type { AuthContext } from '../../src/server/authz/guards';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(settings).where(eq(settings.key, 'site'));
});

async function setVotingSettings(official: boolean, live: boolean) {
  await getDb(env).delete(settings).where(eq(settings.key, 'site'));
  await getDb(env)
    .insert(settings)
    .values({
      key: 'site',
      value: JSON.stringify({
        officialMode: official,
        liveVotingEnabled: live,
      }),
      updatedAt: new Date(),
    });
}

function localsFor(ctx: AuthContext | null) {
  return { authContext: ctx } as unknown as App.Locals;
}

const homeowner: AuthContext = {
  userId: 'homeowner-1',
  role: 'homeowner',
  propertyIds: ['property-1'],
};

async function call({
  official,
  live,
  origin,
  contentType = 'application/json',
  ctx = null,
}: {
  official: boolean;
  live: boolean;
  origin: string | null;
  contentType?: string | null;
  ctx?: AuthContext | null;
}): Promise<Response> {
  await setVotingSettings(official, live);
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  if (contentType !== null) headers.set('content-type', contentType);
  const request = new Request('http://localhost/api/vote', {
    method: 'POST',
    headers,
  });
  const gate = await requireVotingApi(localsFor(ctx), request, env);
  return gate.ok ? new Response('ok') : gate.res;
}

describe('requireVotingApi', () => {
  it('applies flags, exact origin, and auth in the required order', async () => {
    expect(
      (await call({ official: false, live: true, origin: 'foreign' })).status,
    ).toBe(404);
    expect(
      (await call({ official: true, live: false, origin: 'foreign' })).status,
    ).toBe(404);
    expect(
      (await call({ official: true, live: true, origin: null })).status,
    ).toBe(403);
    expect(
      (
        await call({
          official: true,
          live: true,
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          official: true,
          live: true,
          origin: 'http://localhost',
        })
      ).status,
    ).toBe(401);
  });

  it('requires application/json after the exact-origin check', async () => {
    expect(
      (
        await call({
          official: true,
          live: true,
          origin: 'https://evil.test',
          contentType: 'text/plain',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          official: true,
          live: true,
          origin: 'http://localhost',
          contentType: null,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call({
          official: true,
          live: true,
          origin: 'http://localhost',
          contentType: 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call({
          official: true,
          live: true,
          origin: 'http://localhost',
          contentType: 'application/json; charset=utf-8',
        })
      ).status,
    ).toBe(401);
  });

  it('rejects visitors but passes homeowner and board rank', async () => {
    const visitor = await call({
      official: true,
      live: true,
      origin: 'http://localhost',
      ctx: { userId: 'visitor-1', role: 'visitor', propertyIds: [] },
    });
    expect(visitor.status).toBe(403);

    const member = await call({
      official: true,
      live: true,
      origin: 'http://localhost',
      ctx: homeowner,
    });
    expect(member.status).toBe(200);

    const board = await call({
      official: true,
      live: true,
      origin: 'http://localhost',
      ctx: { userId: 'board-1', role: 'board', propertyIds: [] },
    });
    expect(board.status).toBe(200);
  });
});
