// #511: what the public pages say once the board adopts the site. Rendered
// through the real Astro Container API so the assertions see the page a visitor
// would, including the 404 status `Astro.rewrite('/404')` produces. The tests
// with official mode off pass on the old code by design: they guard what the
// resident site must keep saying.
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import AboutPage from '../../src/pages/about.astro';
import HomePage from '../../src/pages/index.astro';
import NotFoundPage from '../../src/pages/404.astro';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../src/lib/types';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container;
}

function localsFor(site: Partial<SiteSettings>) {
  return {
    site: { ...DEFAULT_SITE_SETTINGS, ...site },
  } as unknown as App.Locals;
}

async function renderAbout(site: Partial<SiteSettings>) {
  const container = await makeContainer();
  return container.renderToResponse(AboutPage, {
    locals: localsFor(site),
    request: new Request('http://localhost/about'),
  });
}

describe('/about', () => {
  it('answers the generic 404 in official mode while the board has written nothing', async () => {
    const res = await renderAbout({ officialMode: true, aboutBody: '' });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('Page not found');
    expect(html).not.toContain('not affiliated');
    expect(html).not.toContain('does not own or control');
    expect(html).not.toContain('personal accounts');
    expect(html).not.toContain('management company');
    expect(html).not.toMatch(/independent/i);
    expect(html).not.toMatch(/resident-run/i);
  });

  it('treats whitespace-only text as nothing written', async () => {
    const res = await renderAbout({ officialMode: true, aboutBody: ' \n\n ' });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
  });

  it("shows the board's own text in official mode, described without the resident wording", async () => {
    const res = await renderAbout({
      officialMode: true,
      aboutBody: 'Written by the board.\n\nSecond paragraph.',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Written by the board.');
    expect(html).toContain('Second paragraph.');
    expect(html).not.toContain('not affiliated');
    expect(html).not.toMatch(/independent/i);
    expect(html).not.toMatch(/resident-run/i);
  });

  it('keeps the built-in resident text when official mode is off', async () => {
    const res = await renderAbout({ officialMode: false, aboutBody: '' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'not affiliated with, endorsed by, or operated by the Valleys at Ashebrook HOA',
    );
    expect(html).toContain('independent, resident-run site');
  });

  it('shows a saved override when official mode is off', async () => {
    const res = await renderAbout({
      officialMode: false,
      aboutBody: 'Resident override.',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Resident override.');
    expect(html).not.toContain('not affiliated');
    expect(html).toContain('independent, resident-run site');
  });
});

describe('home page dues tile', () => {
  async function renderHome(site: Partial<SiteSettings>) {
    const container = await makeContainer();
    return container.renderToString(HomePage, {
      locals: localsFor(site),
      request: new Request('http://localhost/'),
    });
  }

  it('names no payment method in official mode, and still links to /dues', async () => {
    const html = await renderHome({ officialMode: true });
    expect(html).not.toMatch(/paypal|venmo|zelle/i);
    expect(html).toContain('Pay Your Dues');
    expect(html).toContain('Pay Dues');
    expect(html).toContain('href="/dues"');
  });

  it('has no dues tile when official mode is off', async () => {
    const html = await renderHome({ officialMode: false });
    expect(html).not.toContain('Pay Your Dues');
    expect(html).not.toContain('href="/dues"');
  });
});
