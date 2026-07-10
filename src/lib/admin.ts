// Admin-only write helpers.
import type {
  Announcement,
  DuesSettings,
  SiteSettings,
  PropertyWithOwners,
  MembersView,
  MemberUser,
  DuplicatesView,
} from './types';

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
    if (!res.ok)
      throw new Error((await res.text()) || `Update failed: ${res.status}`);
  } else {
    const res = await fetch('/api/admin/announcements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok)
      throw new Error((await res.text()) || `Create failed: ${res.status}`);
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
export class DuplicateError extends Error {
  kind: 'exact' | 'near';
  existing?: {
    id: string;
    title?: string;
    category?: string;
    visibility?: string;
  };
  similar?: {
    id: string;
    title?: string;
    filename?: string;
    category?: string;
    visibility?: string;
  }[];

  constructor(
    kind: 'exact' | 'near',
    payload: {
      existing?: DuplicateError['existing'];
      similar?: DuplicateError['similar'];
    },
  ) {
    super(kind === 'exact' ? 'exact-duplicate' : 'near-duplicate');
    this.name = 'DuplicateError';
    this.kind = kind;
    this.existing = payload.existing;
    this.similar = payload.similar;
  }
}

export async function uploadDocument(
  file: File,
  title: string,
  category: string,
  visibility: string = 'board',
  confirmDuplicate: boolean = false,
): Promise<void> {
  const form = new FormData();
  form.set('file', file);
  form.set('title', title);
  form.set('category', category);
  form.set('visibility', visibility);
  if (confirmDuplicate) form.set('confirmDuplicate', 'true');
  const res = await fetch('/api/admin/documents', {
    method: 'POST',
    body: form,
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      warning?: string;
      existing?: DuplicateError['existing'];
      similar?: DuplicateError['similar'];
    };
    if (body.error === 'exact-duplicate')
      throw new DuplicateError('exact', { existing: body.existing });
    if (body.warning === 'near-duplicate')
      throw new DuplicateError('near', { similar: body.similar });
  }
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

export async function fetchDuplicates(): Promise<DuplicatesView> {
  const res = await fetch('/api/admin/duplicates');
  if (!res.ok) throw new Error(`duplicates ${res.status}`);
  return (await res.json()) as DuplicatesView;
}

export async function resolveDuplicates(
  keepIds: string[],
  deleteIds: string[],
): Promise<void> {
  const res = await fetch('/api/admin/duplicates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', keepIds, deleteIds }),
  });
  if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
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

// ---------- Roster (board-only reads + writes) ----------
export async function fetchProperties(): Promise<PropertyWithOwners[]> {
  const res = await fetch('/api/admin/properties');
  if (!res.ok) throw new Error(`Load homes failed: ${res.status}`);
  return res.json();
}

export async function saveProperty(
  data: {
    address?: string;
    unit?: string | null;
    notes?: string | null;
    status?: 'active' | 'inactive';
  },
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/properties', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save home failed: ${res.status}`);
}

export async function saveOwner(
  data: {
    propertyId?: string;
    fullName?: string;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
    status?: 'active' | 'inactive';
  },
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/owners', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save owner failed: ${res.status}`);
}

// ---------- Members / access ----------
export async function fetchMembers(): Promise<MembersView> {
  const res = await fetch('/api/admin/members');
  if (!res.ok) throw new Error(`Load members failed: ${res.status}`);
  return res.json();
}

export async function memberAction(payload: {
  action: 'approve' | 'deny' | 'revoke';
  userId?: string;
  queueId?: string;
  propertyId?: string;
}): Promise<void> {
  const res = await fetch('/api/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Action failed: ${res.status}`);
}

// ---------- Board membership (handoff) ----------
export async function fetchBoardMembers(): Promise<MemberUser[]> {
  const res = await fetch('/api/admin/roles');
  if (!res.ok) throw new Error(`Load board failed: ${res.status}`);
  const data = (await res.json()) as { board: MemberUser[] };
  return data.board;
}

export async function promoteToBoard(email: string): Promise<void> {
  const res = await fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'promote', email }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Promote failed: ${res.status}`);
}

export async function demoteFromBoard(userId: string): Promise<void> {
  const res = await fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'demote', userId }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Demote failed: ${res.status}`);
}
