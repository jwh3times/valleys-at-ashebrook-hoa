import type { APIRoute } from 'astro';

export const prerender = false;

// The public, indexable content pages. Auth-utility pages (/login, /register,
// /verify-property, /reset-password), the officialMode-conditional /dues, and
// everything under /admin and /api are deliberately omitted. Generated per
// request because the site is full SSR — @astrojs/sitemap only emits for
// statically built routes, so it comes up empty here.
const PUBLIC_PATHS = [
  '/',
  '/about',
  '/announcements',
  '/calendar',
  '/contact',
  '/documents',
];

export const GET: APIRoute = ({ site, url }) => {
  const base = (site?.toString() ?? url.origin).replace(/\/$/, '');
  const entries = PUBLIC_PATHS.map(
    (path) => `  <url><loc>${base}${path}</loc></url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
  return new Response(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
