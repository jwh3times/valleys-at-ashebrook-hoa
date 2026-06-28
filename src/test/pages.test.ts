// @vitest-environment node
// The Astro Container API compiles .astro files with esbuild, which conflicts
// with jsdom's TextEncoder. This page test renders to a string, so run it in a
// plain Node environment instead of jsdom.
import { describe, it, expect } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import CalendarPage from '../pages/calendar.astro';

// A page-level (integration) test: render a real Astro page through the
// container API and assert on the full HTML, including the shared layout.
describe('calendar page', () => {
  it('renders the page heading and shared navigation', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(CalendarPage);

    expect(html).toContain('Community Calendar');
    // Shared header navigation from BaseLayout/Header.
    expect(html).toContain('href="/announcements"');
    expect(html).toContain('href="/dues"');
    expect(html).toContain('href="/contact"');
  });

  it('shows a setup notice when no calendar id is configured', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(CalendarPage);
    expect(html).toContain('Setup needed');
  });
});
