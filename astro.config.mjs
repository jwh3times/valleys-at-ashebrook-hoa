// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://valleys-ashebrook.web.app',
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
});
