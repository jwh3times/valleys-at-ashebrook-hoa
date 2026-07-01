import { fileURLToPath } from 'node:url';
import { normalizeAddress } from '../src/server/roster/lookup';

export interface NewOwner {
  fullName: string;
  address: string;
  addressNormalized: string;
  unit: string | null;
  phone: string | null;
  email: string | null;
  status: 'active';
}

export function rowsToOwners(rows: Record<string, string>[]): NewOwner[] {
  return rows.map((r) => ({
    fullName: (r.Name ?? r['Owner'] ?? '').trim(),
    address: (r.Address ?? '').trim(),
    addressNormalized: normalizeAddress(r.Address ?? ''),
    unit: r.Unit?.trim() || null,
    phone: r.Phone?.replace(/\D/g, '') || null,
    email: r.Email?.trim() || null,
    status: 'active',
  }));
}

function sqlStr(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

async function main() {
  const XLSX = await import('xlsx');
  const fs = await import('node:fs');
  const wb = XLSX.readFile('private/HOA_files/Ashebrook HOA Contact List.xlsx');
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    wb.Sheets[wb.SheetNames[0]],
  );
  const ownersList = rowsToOwners(rows);
  const values = ownersList
    .map(
      (o) =>
        `('${crypto.randomUUID()}', ${sqlStr(o.fullName)}, ${sqlStr(o.address)}, ${sqlStr(o.addressNormalized)}, ${sqlStr(o.unit)}, ${sqlStr(o.phone)}, ${sqlStr(o.email)}, 'active', NULL, unixepoch(), unixepoch())`,
    )
    .join(',\n');
  const stmt = `INSERT INTO owners (id, full_name, address, address_normalized, unit, phone, email, status, notes, created_at, updated_at) VALUES\n${values};\n`;
  fs.writeFileSync('private/roster-import.sql', stmt);
  console.log(
    `Wrote private/roster-import.sql (${ownersList.length} owners). Apply with: wrangler d1 execute ashebrook-hoa --remote --file private/roster-import.sql`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
