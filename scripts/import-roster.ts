import { fileURLToPath } from 'node:url';
import { normalizeAddress } from '../src/server/roster/normalize.ts';

export interface NewProperty {
  id: string;
  address: string;
  addressNormalized: string;
  unit: string | null;
}

export interface NewOwner {
  id: string;
  propertyId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
}

// The contact spreadsheet packs multiple, labeled values into single cells, e.g.
//   All Phones:  "John (919) 451-7647, Ginny (919) 816-5442"
//   All Emails:  "a@example.com, b@example.com"
// The OTP channel needs ONE usable value, so pull the first of each.

/** First email-shaped token in the cell, or null. */
export function firstEmail(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = String(raw).match(/[^\s,;]+@[^\s,;]+\.[^\s,;]+/);
  return m ? m[0].trim() : null;
}

/** First US phone in the cell as E.164 (+1XXXXXXXXXX), or null. Twilio's `To`
 * requires E.164. */
export function firstPhoneE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = String(raw).match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  if (!m) return null;
  const d = m[0].replace(/\D/g, '');
  return d.length === 10 ? `+1${d}` : null;
}

export function rowsToRoster(rows: Record<string, string>[]): {
  properties: NewProperty[];
  owners: NewOwner[];
} {
  const properties: NewProperty[] = [];
  const owners: NewOwner[] = [];
  for (const r of rows) {
    const propertyId = crypto.randomUUID();
    const address = String(r['Property Address'] ?? '').trim();
    properties.push({
      id: propertyId,
      address,
      addressNormalized: normalizeAddress(address),
      unit: String(r['Unit No'] ?? '').trim() || null,
    });
    const name1 = String(r['Homeowner 1'] ?? '').trim();
    if (name1) {
      owners.push({
        id: crypto.randomUUID(),
        propertyId,
        fullName: name1,
        phone: firstPhoneE164(r['Homeowner 1 Phone']),
        email: firstEmail(r['Homeowner 1 Email']),
      });
    }
    const name2 = String(r['Homeowner 2'] ?? '').trim();
    if (name2) {
      owners.push({
        id: crypto.randomUUID(),
        propertyId,
        fullName: name2,
        phone: firstPhoneE164(r['Homeowner 2 Phone']),
        email: firstEmail(r['Homeowner 2 Email']),
      });
    }
  }
  return { properties, owners };
}

function sqlStr(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

async function main() {
  const XLSX = await import('xlsx');
  const fs = await import('node:fs');
  // Read bytes with Node's fs and pass a buffer to XLSX.read — the SheetJS ESM
  // build does not wire up `fs` for XLSX.readFile() unless set_fs() is called.
  const buf = fs.readFileSync(
    'private/HOA_files/Ashebrook HOA Contact List.xlsx',
  );
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    wb.Sheets[wb.SheetNames[0]],
  );
  const { properties, owners } = rowsToRoster(rows);
  const propValues = properties
    .map(
      (p) =>
        `('${p.id}', ${sqlStr(p.address)}, ${sqlStr(p.addressNormalized)}, ${sqlStr(p.unit)}, 'active', NULL, unixepoch(), unixepoch())`,
    )
    .join(',\n');
  const ownerValues = owners
    .map(
      (o) =>
        `('${o.id}', '${o.propertyId}', ${sqlStr(o.fullName)}, ${sqlStr(o.phone)}, ${sqlStr(o.email)}, 'active', NULL, unixepoch(), unixepoch())`,
    )
    .join(',\n');
  const stmt =
    `INSERT INTO properties (id, address, address_normalized, unit, status, notes, created_at, updated_at) VALUES\n${propValues};\n\n` +
    `INSERT INTO owners (id, property_id, full_name, phone, email, status, notes, created_at, updated_at) VALUES\n${ownerValues};\n`;
  fs.writeFileSync('private/roster-import.sql', stmt);
  console.log(
    `Wrote private/roster-import.sql (${properties.length} homes, ${owners.length} owners). Apply with: wrangler d1 execute ashebrook-hoa --remote --file private/roster-import.sql`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
