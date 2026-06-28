// Client-side read helpers for public content stored in Firestore.
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
} from 'firebase/firestore';
import { getDb } from './firebase';
import {
  DEFAULT_DUES_SETTINGS,
  DEFAULT_SITE_SETTINGS,
  type Announcement,
  type DocumentItem,
  type DuesSettings,
  type SiteSettings,
} from './types';

export async function fetchAnnouncements(): Promise<Announcement[]> {
  const db = getDb();
  const snap = await getDocs(
    query(collection(db, 'announcements'), orderBy('date', 'desc')),
  );
  const items = snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<Announcement, 'id'>) }),
  );
  // Pinned announcements float to the top, otherwise keep date-desc order.
  return items.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

export async function fetchDocuments(): Promise<DocumentItem[]> {
  const db = getDb();
  const snap = await getDocs(
    query(collection(db, 'documents'), orderBy('title')),
  );
  return snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<DocumentItem, 'id'>) }),
  );
}

export async function fetchDuesSettings(): Promise<DuesSettings> {
  const db = getDb();
  const snap = await getDoc(doc(db, 'settings', 'dues'));
  if (!snap.exists()) return DEFAULT_DUES_SETTINGS;
  return { ...DEFAULT_DUES_SETTINGS, ...(snap.data() as Partial<DuesSettings>) };
}

export async function fetchSiteSettings(): Promise<SiteSettings> {
  const db = getDb();
  const snap = await getDoc(doc(db, 'settings', 'site'));
  if (!snap.exists()) return DEFAULT_SITE_SETTINGS;
  return { ...DEFAULT_SITE_SETTINGS, ...(snap.data() as Partial<SiteSettings>) };
}

/** Group documents by their category for display. */
export function groupDocumentsByCategory(
  docs: DocumentItem[],
): Record<string, DocumentItem[]> {
  return docs.reduce<Record<string, DocumentItem[]>>((acc, d) => {
    const key = d.category || 'Other';
    (acc[key] ??= []).push(d);
    return acc;
  }, {});
}
