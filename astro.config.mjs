// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  // Update `site` once you know your live URL (Firebase subdomain or custom domain).
  site: 'https://valleys-ashebrook.web.app',
  integrations: [react()],
});
