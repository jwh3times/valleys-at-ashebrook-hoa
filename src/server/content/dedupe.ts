// Pure duplicate-detection engine shared by the upload guard, the admin
// duplicates panel, and the bulk cleanup script. No I/O — callers supply docs.
export interface DocLike {
  id: string;
  title: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  visibility: 'public' | 'homeowner' | 'board';
  category?: string;
  uploadedAt?: number | Date;
  contentHash?: string | null;
}

export interface DupeGroup {
  members: DocLike[];
  suggestedKeepId: string;
  reason?: string;
}

/** Near-duplicate cutoff for `nearScore`. Tunable; see the metadata weights below. */
export const NEAR_THRESHOLD = 0.6;

/** Lowercase-hex SHA-256 of the given bytes. Works in Workers and Node. */
export async function sha256Hex(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string> {
  // Both an ArrayBuffer and any Uint8Array are valid digest inputs at runtime;
  // the assertion just reconciles the ArrayBufferLike-vs-ArrayBuffer variance
  // between the DOM and Workers `BufferSource` typings.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalize a filename/title into comparable tokens: drop the extension, strip
 * copy markers `(1)`/`copy` and timestamp stamps like `_20241216-1453` and
 * trailing `-1`, lowercase, and split on non-alphanumerics. Bare numbers (years,
 * `08`) survive as tokens; only `_`/`-`-prefixed number runs are treated as stamps.
 */
export function normalizeName(name: string): string[] {
  const noExt = name.replace(/\.[^.]+$/, '');
  const stripped = noExt
    .toLowerCase()
    .replace(/\(\d+\)/g, ' ')
    .replace(/\bcopy\b/g, ' ')
    .replace(/[_-]?\d{8}-\d{4}\b/g, ' ')
    .replace(/[_-]\d+\b/g, ' ');
  return stripped.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Sørensen–Dice coefficient over the two token *sets*, in [0,1]. */
export function tokenSimilarity(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

/** True when two byte sizes are within `tolerance` (fraction) of each other. */
export function sizeSimilar(a: number, b: number, tolerance = 0.05): boolean {
  if (a === b) return true;
  const larger = Math.max(a, b);
  if (larger === 0) return true;
  return Math.abs(a - b) / larger <= tolerance;
}

/**
 * Metadata-only similarity in [0,1]. Same content-type is required (different
 * types are never near-duplicates); score is name-token similarity plus a small
 * boost when sizes are close.
 */
export function nearScore(a: DocLike, b: DocLike): number {
  if (a.contentType !== b.contentType) return 0;
  const nameSim = tokenSimilarity(
    normalizeName(`${a.title} ${a.filename}`),
    normalizeName(`${b.title} ${b.filename}`),
  );
  const sizeBoost = sizeSimilar(a.sizeBytes, b.sizeBytes) ? 0.2 : 0;
  return Math.min(1, nameSim + sizeBoost);
}

/** Cleanest filename wins: no copy/timestamp marker, then shortest, then oldest. */
export function suggestedKeepId(members: DocLike[]): string {
  const rank = (d: DocLike) => ({
    marked:
      /\(\d+\)/.test(d.filename) || /\d{8}-\d{4}/.test(d.filename) ? 1 : 0,
    len: d.filename.length,
    when:
      typeof d.uploadedAt === 'number'
        ? d.uploadedAt
        : d.uploadedAt instanceof Date
          ? d.uploadedAt.getTime()
          : Number.MAX_SAFE_INTEGER,
  });
  return [...members].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra.marked - rb.marked || ra.len - rb.len || ra.when - rb.when;
  })[0].id;
}

/** Group documents by identical content hash (null hashes ignored). Size >= 2. */
export function groupExact(docs: DocLike[]): DupeGroup[] {
  const byHash = new Map<string, DocLike[]>();
  for (const d of docs) {
    if (!d.contentHash) continue;
    const arr = byHash.get(d.contentHash) ?? [];
    arr.push(d);
    byHash.set(d.contentHash, arr);
  }
  const groups: DupeGroup[] = [];
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    groups.push({ members, suggestedKeepId: suggestedKeepId(members) });
  }
  return groups;
}

/**
 * Group near-duplicates via connected components over pairs scoring at/above
 * `NEAR_THRESHOLD`. Pairs already identical by content hash are skipped — they
 * belong to `groupExact`, not here.
 */
export function groupNear(docs: DocLike[]): DupeGroup[] {
  const n = docs.length;
  const parent = docs.map((_, i) => i);
  const find = (x: number): number =>
    parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const hi = docs[i].contentHash;
      if (hi && hi === docs[j].contentHash) continue;
      if (nearScore(docs[i], docs[j]) >= NEAR_THRESHOLD) union(i, j);
    }
  }
  const byRoot = new Map<number, DocLike[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(docs[i]);
    byRoot.set(r, arr);
  }
  const groups: DupeGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    groups.push({
      members,
      suggestedKeepId: suggestedKeepId(members),
      reason: 'similar filename/size',
    });
  }
  return groups;
}

/**
 * Safety rule: an exact group may be auto-collapsed only when every member
 * shares one visibility tier (the surviving copy is byte-identical, so no data
 * loss). Cross-tier groups return null — they need a human decision.
 */
export function autoResolvableExact(
  group: DupeGroup,
): { keepId: string; deleteIds: string[] } | null {
  const tiers = new Set(group.members.map((m) => m.visibility));
  if (tiers.size !== 1) return null;
  const keepId = group.suggestedKeepId;
  const deleteIds = group.members
    .filter((m) => m.id !== keepId)
    .map((m) => m.id);
  return { keepId, deleteIds };
}
