import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Migration 0045 (#294 slice 4): creates `tenancy_invitations`, the claim
// credential. The table holds only the token's HMAC, never the token, and an
// invitation ends exactly one way: consumed by an Account, or superseded by a
// newer one.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO lots (id, address, address_normalized, status, created_at, updated_at)
       VALUES ('lot-a', '1 Example Way', '1 example way', 'active', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO parties (id, kind, created_at, updated_at)
       VALUES ('owner', 'person', 1, 1), ('tenant', 'person', 1, 1),
              ('org', 'organization', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
       VALUES ('owner', 'person', 'Olive Owner', 'olive owner', 1),
              ('tenant', 'person', 'Tess Tenant', 'tess tenant', 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
       VALUES ('org', 'organization', 'Example Holdings', 'example holdings', 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO contact_methods (id, party_id, party_kind, channel, value, value_normalized, created_at, updated_at)
       VALUES ('cm-tenant', 'tenant', 'person', 'email', 'tess@example.test', 'tess@example.test', 1, 1),
              ('cm-org', 'org', 'organization', 'email', 'office@example.test', 'office@example.test', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
       VALUES ('own-a', 'owner', 'lot-a', '2025-01-01', 1, 1)`,
    ),
    env.DATABASE.prepare(
      `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id, start_day, scheduled_end_day, created_at, updated_at)
       VALUES ('ten', 'tenant', 'lot-a', 'own-a', '2026-01-01', '2027-01-01', 1, 1)`,
    ),
  ]);
});

let seq = 0;

/** Inserts an invitation; `columns` override a fresh, unconsumed one. */
function insertInvitation(
  columns: Record<string, string | number | null> = {},
) {
  const row: Record<string, string | number | null> = {
    id: `inv-${++seq}`,
    tenancy_id: 'ten',
    contact_method_id: 'cm-tenant',
    channel: 'email',
    token_hash: `hash-${seq}`,
    expires_at: 1_000,
    created_at: 1,
    ...columns,
  };
  const names = Object.keys(row);
  return env.DATABASE.prepare(
    `INSERT INTO tenancy_invitations (${names.join(', ')})
     VALUES (${names.map(() => '?').join(', ')})`,
  )
    .bind(...names.map((n) => row[n]))
    .run();
}

describe('tenancy_invitations', () => {
  it('records a fresh invitation as unconsumed and unsuperseded', async () => {
    await insertInvitation({ id: 'fresh' });
    expect(
      await env.DATABASE.prepare(
        `SELECT consumed_at, consumed_by_account_id, superseded_at,
                contact_method_party_kind
         FROM tenancy_invitations WHERE id = 'fresh'`,
      ).first(),
    ).toEqual({
      consumed_at: null,
      consumed_by_account_id: null,
      superseded_at: null,
      contact_method_party_kind: 'person',
    });
  });

  it('allows each token hash once', async () => {
    await insertInvitation({ token_hash: 'same' });
    await expect(insertInvitation({ token_hash: 'same' })).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('refuses an unknown channel', async () => {
    await expect(insertInvitation({ channel: 'fax' })).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('expires after it was created', async () => {
    await expect(
      insertInvitation({ created_at: 5, expires_at: 5 }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('records the consuming Account exactly when consumed', async () => {
    await expect(insertInvitation({ consumed_at: 2 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertInvitation({ consumed_by_account_id: 'acct' }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await insertInvitation({ consumed_at: 2, consumed_by_account_id: 'acct' });
  });

  it('is never both consumed and superseded', async () => {
    await insertInvitation({ superseded_at: 2 });
    await expect(
      insertInvitation({
        consumed_at: 2,
        consumed_by_account_id: 'acct',
        superseded_at: 3,
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("names only a Person's Contact Method", async () => {
    await expect(
      insertInvitation({ contact_method_id: 'cm-org' }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keeps every reference intact', async () => {
    expect(
      (await env.DATABASE.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
    await expect(insertInvitation({ tenancy_id: 'no-such' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});
