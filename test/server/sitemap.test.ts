import { describe, it, expect } from 'vitest';
import { GET } from '../../src/pages/sitemap.xml';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../src/lib/types';

function call(settings?: Partial<SiteSettings>) {
  return GET({
    site: new URL('https://ashebrookresidents.com'),
    url: new URL('http://localhost/sitemap.xml'),
    locals: settings ? { site: { ...DEFAULT_SITE_SETTINGS, ...settings } } : {},
  } as never) as Promise<Response>;
}

const ABOUT_ENTRY = '<loc>https://ashebrookresidents.com/about</loc>';

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
    expect(body).toContain('<loc>https://ashebrookresidents.com/privacy</loc>');
  });

  it('excludes admin, api, and auth-utility routes', async () => {
    const body = await (await call()).text();
    expect(body).not.toContain('/admin');
    expect(body).not.toContain('/api');
    expect(body).not.toContain('/login');
    expect(body).not.toContain('/register');
  });

  it('leaves out /about in official mode while the board has written nothing', async () => {
    for (const aboutBody of ['', '  \n  ']) {
      const res = await call({ officialMode: true, aboutBody });
      const body = await res.text();
      expect(body).not.toContain(ABOUT_ENTRY);
      expect(body).toContain(
        '<loc>https://ashebrookresidents.com/privacy</loc>',
      );
    }
  });

  it('lists /about in official mode once the board has written its text', async () => {
    const res = await call({
      officialMode: true,
      aboutBody: 'Written by the board.',
    });
    expect(await res.text()).toContain(ABOUT_ENTRY);
  });

  it('lists /about when official mode is off, with or without saved text', async () => {
    for (const aboutBody of ['', 'Resident override.']) {
      const res = await call({ officialMode: false, aboutBody });
      expect(await res.text()).toContain(ABOUT_ENTRY);
    }
  });
});
