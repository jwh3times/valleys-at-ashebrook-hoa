import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Provide a minimal Firebase config so `isFirebaseConfigured` is true in tests
// (the components then take their "fetch real content" path). The Firestore
// layer itself is mocked in each test, so no network calls are made.
vi.stubEnv('PUBLIC_FIREBASE_API_KEY', 'test-api-key');
vi.stubEnv('PUBLIC_FIREBASE_PROJECT_ID', 'test-project');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
