// Admin-only write helpers. All of these require the signed-in user to be in
// the Firestore /admins collection — enforced by security rules, not just here.
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
} from 'firebase/storage';
import { getDb, getStorageInstance } from './firebase';
import type {
  Announcement,
  DocumentItem,
  DuesSettings,
  SiteSettings,
} from './types';

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
  const db = getDb();
  if (id) {
    await updateDoc(doc(db, 'announcements', id), data);
  } else {
    await addDoc(collection(db, 'announcements'), data);
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await deleteDoc(doc(getDb(), 'announcements', id));
}

// ---------- Documents ----------
export async function uploadDocument(
  file: File,
  title: string,
  category: string,
): Promise<void> {
  const storage = getStorageInstance();
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `documents/${Date.now()}-${safeName}`;
  const fileRef = ref(storage, storagePath);
  await uploadBytes(fileRef, file, { contentType: 'application/pdf' });
  const url = await getDownloadURL(fileRef);
  await addDoc(collection(getDb(), 'documents'), {
    title,
    category,
    url,
    storagePath,
    updatedAt: new Date().toISOString().slice(0, 10),
    visibility: 'board',
  } satisfies Omit<DocumentItem, 'id'>);
}

export async function deleteDocument(item: DocumentItem): Promise<void> {
  // Remove the stored file first, then its metadata.
  try {
    await deleteObject(ref(getStorageInstance(), item.storagePath));
  } catch {
    // File may already be gone; continue removing the metadata.
  }
  await deleteDoc(doc(getDb(), 'documents', item.id));
}

// ---------- Settings (singletons) ----------
export async function saveDues(dues: DuesSettings): Promise<void> {
  await setDoc(doc(getDb(), 'settings', 'dues'), dues);
}

export async function saveSite(site: SiteSettings): Promise<void> {
  await setDoc(doc(getDb(), 'settings', 'site'), site);
}
