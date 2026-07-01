// Admin-only write helpers.
import type { Announcement, DuesSettings, SiteSettings } from './types';

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
  const res = await fetch('/api/admin/dues', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dues),
  });
  if (!res.ok) throw new Error(`Save dues failed: ${res.status}`);
}

export async function saveSite(site: SiteSettings): Promise<void> {
  const res = await fetch('/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(site),
  });
  if (!res.ok) throw new Error(`Save site failed: ${res.status}`);
}
