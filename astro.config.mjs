// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://ashebrookeresidents.com',
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
});
