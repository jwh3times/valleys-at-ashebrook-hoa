/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// Reuse Astro's Vite config so tests can import .astro files and TSX/JSX with
// the same resolution as the app.
export default getViteConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx,astro}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**'],
    },
  },
});
