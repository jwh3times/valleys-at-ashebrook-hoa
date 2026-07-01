// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://valleys-at-ashebrook-hoa.jerryholland00.workers.dev',
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
});
