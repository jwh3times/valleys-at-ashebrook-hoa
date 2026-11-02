import type { APIRoute } from 'astro';
import { hasAboutPage } from '../lib/site';
import { DEFAULT_SITE_SETTINGS } from '../lib/types';

export const prerender = false;

// The public, indexable content pages. Auth-utility pages (/login, /register,
// /verify-property, /reset-password), the officialMode-conditional /dues, and
// everything under /admin and /api are deliberately omitted. Generated per
// request because the site is full SSR — @astrojs/sitemap only emits for
// statically built routes, so it comes up empty here. /meetings/[id] is
// deliberately NOT listed here — those are per-record and tier-dependent,
// same reasoning as why /documents/[id] downloads aren't listed either. /about
// is listed only while the page exists, which depends on the mode.
const PUBLIC_PATHS = [
  '/',
  '/about',
  '/announcements',
  '/calendar',
  '/contact',
  '/documents',
  '/meetings',
  '/privacy',
];

export const GET: APIRoute = ({ site, url, locals }) => {
  const base = (site?.toString() ?? url.origin).replace(/\/$/, '');
  const settings = locals.site ?? DEFAULT_SITE_SETTINGS;
  const entries = PUBLIC_PATHS.filter(
    (path) => path !== '/about' || hasAboutPage(settings),
  )
    .map((path) => `  <url><loc>${base}${path}</loc></url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
  return new Response(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
