// Client-side read helpers — fetches public content from the D1-backed API endpoints.
import {
  type Announcement,
  type DocumentItem,
  type DuesSettings,
  type SiteSettings,
  DOCUMENT_CATEGORIES,
  normalizeSiteSettings,
} from './types';

export async function fetchAnnouncements(): Promise<Announcement[]> {
  const res = await fetch('/api/content/announcements');
  if (!res.ok) throw new Error(`announcements ${res.status}`);
  return (await res.json()) as Announcement[];
}

export async function fetchDocuments(): Promise<DocumentItem[]> {
  const res = await fetch('/api/content/documents');
  if (!res.ok) throw new Error(`documents ${res.status}`);
  return (await res.json()) as DocumentItem[];
}

export async function fetchDuesSettings(): Promise<DuesSettings> {
  const res = await fetch('/api/content/dues');
  if (!res.ok) throw new Error(`dues ${res.status}`);
  return (await res.json()) as DuesSettings;
}

export async function fetchSiteSettings(): Promise<SiteSettings> {
  const res = await fetch('/api/content/site');
  if (!res.ok) throw new Error(`site ${res.status}`);
  return normalizeSiteSettings(await res.json());
}

/** Group documents by their category for display, ordered by DOCUMENT_CATEGORIES. */
export function groupDocumentsByCategory(
  docs: DocumentItem[],
): Record<string, DocumentItem[]> {
  const groups = docs.reduce<Record<string, DocumentItem[]>>((acc, d) => {
    const key = d.category || 'Other';
    (acc[key] ??= []).push(d);
    return acc;
  }, {});
  const order = (c: string) => {
    const i = (DOCUMENT_CATEGORIES as readonly string[]).indexOf(c);
    return i === -1 ? DOCUMENT_CATEGORIES.length : i;
  };
  return Object.fromEntries(
    Object.entries(groups).sort(([a], [b]) => order(a) - order(b)),
  );
}
