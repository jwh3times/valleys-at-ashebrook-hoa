import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Migration 0044 (#294 slice 3): creates `tenancy_requests`. An owner's
// request is not a roster fact, so the table holds the tenant's name and
// contact only while the request is open; the CHECKs pin that and the
// decision columns' pairing.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO lots (id, address, address_normalized, status, created_at, updated_at)
       VALUES ('lot-a', '1 Example Way', '1 example way', 'active', 1, 1),
              ('lot-b', '2 Example Way', '2 example way', 'active', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO parties (id, kind, created_at, updated_at)
       VALUES ('owner', 'person', 1, 1), ('tenant', 'person', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
       VALUES ('owner', 'person', 'Olive Owner', 'olive owner', 1),
              ('tenant', 'person', 'Tess Tenant', 'tess tenant', 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
       VALUES ('own-a', 'owner', 'lot-a', '2025-01-01', 1, 1),
              ('own-b', 'owner', 'lot-b', '2025-01-01', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id, start_day, scheduled_end_day, created_at, updated_at)
       VALUES ('ten', 'tenant', 'lot-a', 'own-a', '2026-01-01', '2027-01-01', 1, 1),
              ('ten-b', 'tenant', 'lot-b', 'own-b', '2026-01-01', '2027-01-01', 1, 1)`,
    ),
  ]);
});

let seq = 0;

/** Inserts a request; `columns` override the open `new` request's defaults. */
function insertRequest(columns: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = {
    id: `req-${++seq}`,
    lot_id: 'lot-a',
    requested_by_account_id: 'acct-owner',
    requested_by_person_id: 'owner',
    basis_ownership_id: 'own-a',
    kind: 'new',
    tenant_name: 'Tess Tenant',
    channel: 'email',
    contact_value: `Tess${seq}@Example.test`,
    contact_normalized: `tess${seq}@example.test`,
    scheduled_end_day: '2027-06-01',
    created_at: 1,
    ...columns,
  };
  const names = Object.keys(row);
  return env.DATABASE.prepare(
    `INSERT INTO tenancy_requests (${names.join(', ')})
     VALUES (${names.map(() => '?').join(', ')})`,
  )
    .bind(...names.map((n) => row[n]))
    .run();
}

const CLEARED = {
  tenant_name: null,
  channel: null,
  contact_value: null,
  contact_normalized: null,
};
const DECIDED = { decided_at: 2, decided_by_account_id: 'acct-board' };

describe('tenancy_requests', () => {
  it('opens a new request with a name and contact, defaulting to open', async () => {
    await insertRequest({ id: 'open-new' });
    expect(
      await env.DATABASE.prepare(
        `SELECT status, decided_at FROM tenancy_requests WHERE id = 'open-new'`,
      ).first(),
    ).toEqual({ status: 'open', decided_at: null });
  });

  it('refuses an open new request missing any part of the name or contact', async () => {
    for (const column of Object.keys(CLEARED))
      await expect(insertRequest({ [column]: null })).rejects.toThrow(
        /CHECK constraint failed/,
      );
  });

  it('refuses a decided request that still holds a name or contact', async () => {
    for (const column of Object.keys(CLEARED))
      await expect(
        insertRequest({
          ...CLEARED,
          [column]: 'kept',
          status: 'withdrawn',
          ...DECIDED,
        }),
      ).rejects.toThrow(/CHECK constraint failed/);
    await insertRequest({ ...CLEARED, status: 'withdrawn', ...DECIDED });
  });

  it('ties a renewal to the Tenancy it renews, with no name or contact', async () => {
    await insertRequest({
      ...CLEARED,
      kind: 'renewal',
      renews_tenancy_id: 'ten',
    });
    await expect(
      insertRequest({ ...CLEARED, kind: 'renewal' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertRequest({ renews_tenancy_id: 'ten' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('refuses an unknown kind, status or channel', async () => {
    // Each row is otherwise valid, so only the value under test can fail it.
    await expect(insertRequest({ ...CLEARED, kind: 'sublet' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertRequest({ ...CLEARED, status: 'pending', ...DECIDED }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertRequest({ channel: 'fax' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('sets the decision instant and decider together, exactly when decided', async () => {
    await expect(
      insertRequest({ ...CLEARED, status: 'withdrawn' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRequest({ ...CLEARED, status: 'withdrawn', decided_at: 2 }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertRequest({ ...DECIDED })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('requires a reason exactly on a refusal and a Tenancy exactly on an approval', async () => {
    await expect(
      insertRequest({ ...CLEARED, status: 'refused', ...DECIDED }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await insertRequest({
      ...CLEARED,
      status: 'refused',
      ...DECIDED,
      refusal_reason: 'Not a current owner',
    });
    await expect(insertRequest({ refusal_reason: 'early' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertRequest({ ...CLEARED, status: 'approved', ...DECIDED }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await insertRequest({
      ...CLEARED,
      status: 'approved',
      ...DECIDED,
      tenancy_id: 'ten',
    });
    await expect(insertRequest({ tenancy_id: 'ten' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('allows one open request per Lot and normalized contact, and one open renewal per Tenancy', async () => {
    await insertRequest({ contact_normalized: 'dup@example.test' });
    await expect(
      insertRequest({ contact_normalized: 'dup@example.test' }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    // Another Lot, or a decided request, does not collide.
    await insertRequest({
      contact_normalized: 'dup@example.test',
      lot_id: 'lot-b',
      basis_ownership_id: 'own-b',
    });
    const renewal = {
      ...CLEARED,
      kind: 'renewal',
      renews_tenancy_id: 'ten-b',
      lot_id: 'lot-b',
      basis_ownership_id: 'own-b',
    };
    await insertRequest(renewal);
    await expect(insertRequest(renewal)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('keeps every reference intact', async () => {
    expect(
      (await env.DATABASE.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
    await expect(insertRequest({ lot_id: 'no-such-lot' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
