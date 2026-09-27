import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, it, expect } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(
    env.DATABASE,
    env.MIGRATIONS!.filter((m) => Number.parseInt(m.name, 10) < 38),
  );
  await env.DATABASE.prepare(
    "INSERT INTO lots (id,address,address_normalized,status,created_at,updated_at) VALUES ('active','1 Example Way','1 example way','active',1,1), ('retired','2 Example Way','2 example way','inactive',1,1)",
  ).run();
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
it('preserves old Lots without inventing plat numbers and permits old-style inserts', async () => {
  expect(
    (
      await env.DATABASE.prepare(
        'SELECT id,plat_lot_number FROM lots ORDER BY id',
      ).all()
    ).results,
  ).toEqual([
    { id: 'active', plat_lot_number: null },
    { id: 'retired', plat_lot_number: null },
  ]);
  await env.DATABASE.prepare(
    "INSERT INTO lots (id,address,address_normalized,created_at,updated_at) VALUES ('new','3 Example Way','3 example way',1,1)",
  ).run();
  expect(
    await env.DATABASE.prepare(
      "SELECT plat_lot_number FROM lots WHERE id='new'",
    ).first(),
  ).toEqual({ plat_lot_number: null });
  expect(
    (await env.DATABASE.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
it('enforces canonical labels and uniqueness independently of the API', async () => {
  await env.DATABASE.prepare(
    "UPDATE lots SET plat_lot_number='12A' WHERE id='active'",
  ).run();
  await expect(
    env.DATABASE.prepare(
      "UPDATE lots SET plat_lot_number='12A' WHERE id='retired'",
    ).run(),
  ).rejects.toThrow();
  for (const value of ['', '12a', ' 12', '0', '01', '12AB', '1234567']) {
    await expect(
      env.DATABASE.prepare(
        "UPDATE lots SET plat_lot_number=? WHERE id='retired'",
      )
        .bind(value)
        .run(),
    ).rejects.toThrow();
  }
});
