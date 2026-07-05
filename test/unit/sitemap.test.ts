import { describe, it, expect } from 'vitest';
import { GET } from '../../src/pages/sitemap.xml';

function call(site = 'https://ashebrookresidents.com') {
  return GET({
    site: new URL(site),
    url: new URL('http://localhost/sitemap.xml'),
  } as never) as Promise<Response>;
}

describe('GET /sitemap.xml', () => {
  it('serves XML listing the public content pages as absolute URLs', async () => {
    const res = await call();
    expect(res.headers.get('content-type')).toContain('xml');
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>https://ashebrookresidents.com/</loc>');
    expect(body).toContain(
      '<loc>https://ashebrookresidents.com/announcements</loc>',
    );
    expect(body).toContain(
      '<loc>https://ashebrookresidents.com/documents</loc>',
    );
  });

  it('excludes admin, api, and auth-utility routes', async () => {
    const body = await (await call()).text();
    expect(body).not.toContain('/admin');
    expect(body).not.toContain('/api');
    expect(body).not.toContain('/login');
    expect(body).not.toContain('/register');
  });
});
