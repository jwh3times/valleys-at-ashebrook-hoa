// Firebase client initialization. Safe to run in the browser — the config
// values are public by design; access is controlled by Firestore/Storage rules.
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';
import {
  getStorage,
  connectStorageEmulator,
  type FirebaseStorage,
} from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID,
};

/** True when the required Firebase config has been provided via env vars. */
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId,
);

let app: FirebaseApp | undefined;
let authInstance: Auth | undefined;
let dbInstance: Firestore | undefined;
let storageInstance: FirebaseStorage | undefined;
let emulatorsConnected = false;

function ensureApp(): FirebaseApp {
  if (!isFirebaseConfigured) {
    throw new Error(
      'Firebase is not configured. Copy .env.example to .env and fill in the PUBLIC_FIREBASE_* values.',
    );
  }
  if (!app) {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  }
  return app;
}

function maybeConnectEmulators() {
  if (emulatorsConnected) return;
  if (import.meta.env.PUBLIC_USE_EMULATORS !== 'true') return;
  if (typeof window === 'undefined') return;
  connectAuthEmulator(authInstance!, 'http://127.0.0.1:9099', {
    disableWarnings: true,
  });
  connectFirestoreEmulator(dbInstance!, '127.0.0.1', 8080);
  connectStorageEmulator(storageInstance!, '127.0.0.1', 9199);
  emulatorsConnected = true;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) authInstance = getAuth(ensureApp());
  if (!dbInstance) dbInstance = getFirestore(ensureApp());
  if (!storageInstance) storageInstance = getStorage(ensureApp());
  maybeConnectEmulators();
  return authInstance;
}

export function getDb(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(ensureApp());
  getFirebaseAuth();
  return dbInstance;
}

export function getStorageInstance(): FirebaseStorage {
  if (!storageInstance) storageInstance = getStorage(ensureApp());
  getFirebaseAuth();
  return storageInstance;
}
