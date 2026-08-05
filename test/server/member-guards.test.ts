import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireMemberApi } from '../../src/server/authz/member-guards';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import type { AuthContext } from '../../src/server/authz/guards';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(settings).where(eq(settings.key, 'site'));
});

async function setOfficialMode(on: boolean) {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  if (on)
    await db.insert(settings).values({
      key: 'site',
      value: JSON.stringify({ officialMode: true }),
      updatedAt: new Date(),
    });
}

function localsFor(ctx: AuthContext | null) {
  return { authContext: ctx } as unknown as App.Locals;
}

const req = new Request('http://localhost/api/member/proxies');
const homeowner: AuthContext = {
  userId: 'u1',
  role: 'homeowner',
  propertyIds: ['p1'],
};

describe('requireMemberApi', () => {
  it('returns 404 when officialMode is off, even for a signed-in homeowner', async () => {
    await setOfficialMode(false);
    const gate = await requireMemberApi(localsFor(homeowner), req, env);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(404);
  });

  it('returns 404 with no settings row at all (fail-closed default)', async () => {
    const gate = await requireMemberApi(localsFor(homeowner), req, env);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(404);
  });

  it('returns 401 for an anonymous caller with officialMode on', async () => {
    await setOfficialMode(true);
    const gate = await requireMemberApi(localsFor(null), req, env);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(401);
  });

  it('returns 403 for a visitor-role caller with officialMode on', async () => {
    await setOfficialMode(true);
    const gate = await requireMemberApi(
      localsFor({ userId: 'u2', role: 'visitor', propertyIds: [] }),
      req,
      env,
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(403);
  });

  it('passes a homeowner and a board caller with officialMode on', async () => {
    await setOfficialMode(true);
    const h = await requireMemberApi(localsFor(homeowner), req, env);
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.ctx.userId).toBe('u1');
    const b = await requireMemberApi(
      localsFor({ userId: 'b1', role: 'board', propertyIds: [] }),
      req,
      env,
    );
    expect(b.ok).toBe(true);
  });

  it('the officialMode check runs before auth: anonymous + mode off is 404, not 401', async () => {
    await setOfficialMode(false);
    const gate = await requireMemberApi(localsFor(null), req, env);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.res.status).toBe(404);
  });
});
