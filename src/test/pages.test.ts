// @vitest-environment node
// The Astro Container API compiles .astro files with esbuild, which conflicts
// with jsdom's TextEncoder. This page test renders to a string, so run it in a
// plain Node environment instead of jsdom.
import { describe, it, expect } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import CalendarPage from '../pages/calendar.astro';
import { DEFAULT_SITE_SETTINGS } from '../lib/types';

// A page-level (integration) test: render a real Astro page through the
// container API and assert on the full HTML, including the shared layout.
// The Container API does not run middleware, so Astro.locals.site is
// whatever `locals` we pass in (or undefined, which the chrome falls back
// to DEFAULT_SITE_SETTINGS for).
describe('calendar page', () => {
  it('renders the page heading and shared navigation in default mode', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(CalendarPage);

    expect(html).toContain('Community Calendar');
    // Shared header navigation from BaseLayout/Header.
    expect(html).toContain('href="/announcements"');
    expect(html).toContain('href="/contact"');
    // Dues is hidden in default (non-official) mode.
    expect(html).not.toContain('href="/dues"');
  });

  it('shows the dues nav link in official mode', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(CalendarPage, {
      // Only `site` matters for this render; the rest of App.Locals isn't
      // touched by the calendar page or shared chrome.
      locals: {
        site: { ...DEFAULT_SITE_SETTINGS, officialMode: true },
      } as App.Locals,
    });

    expect(html).toContain('href="/dues"');
  });

  it('shows a setup notice when no calendar id is configured', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(CalendarPage);
    expect(html).toContain('Setup needed');
  });
});
