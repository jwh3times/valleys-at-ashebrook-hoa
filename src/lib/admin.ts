// Admin-only write helpers. All of these require the signed-in user to be in
// the Firestore /admins collection — enforced by security rules, not just here.
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getDb } from './firebase';
import type { Announcement, DuesSettings, SiteSettings } from './types';

/** Check whether a user UID has board-admin rights. */
export async function checkIsAdmin(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(getDb(), 'admins', uid));
  return snap.exists();
}

// ---------- Announcements ----------
export async function saveAnnouncement(
  data: Omit<Announcement, 'id'>,
  id?: string,
): Promise<void> {
  if (id) {
    const res = await fetch('/api/admin/announcements', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...data }),
    });
    if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  } else {
    const res = await fetch('/api/admin/announcements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Create failed: ${res.status}`);
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const res = await fetch('/api/admin/announcements', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ---------- Documents ----------
export async function uploadDocument(
  file: File,
  title: string,
  category: string,
  visibility: string = 'board',
): Promise<void> {
  const form = new FormData();
  form.set('file', file);
  form.set('title', title);
  form.set('category', category);
  form.set('visibility', visibility);
  const res = await fetch('/api/admin/documents', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

export async function editDocument(
  id: string,
  patch: { title?: string; category?: string; visibility?: string },
): Promise<void> {
  const res = await fetch('/api/admin/documents', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  });
  if (!res.ok) throw new Error(`Edit failed: ${res.status}`);
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch('/api/admin/documents', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ---------- Settings (singletons) ----------
export async function saveDues(dues: DuesSettings): Promise<void> {
  await setDoc(doc(getDb(), 'settings', 'dues'), dues);
}

export async function saveSite(site: SiteSettings): Promise<void> {
  await setDoc(doc(getDb(), 'settings', 'site'), site);
}
