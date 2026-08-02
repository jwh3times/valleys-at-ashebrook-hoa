// Page-level (integration) tests for the public resolutions book page,
// rendered through the real Astro Container API inside the actual Workers
// runtime (via @cloudflare/vitest-pool-workers) — see meeting-pages.test.ts
// for why this setup is needed (`import { env } from 'cloudflare:workers'`
// in the page must resolve exactly as it does in production).
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import { getDb } from '../../src/server/db/client';
import { resolutions } from '../../src/server/db/schema';
import ResolutionsPage from '../../src/pages/resolutions.astro';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  // supersedes_id is ON DELETE RESTRICT and SQLite enforces it per-row
  // immediately, so an unqualified delete fails the moment any test leaves a
  // valid chain behind. Break links first, same as resolution-reads.test.ts.
  await db.update(resolutions).set({ supersedesId: null });
  await db.delete(resolutions);
});

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  return container;
}

async function seed(id: string, overrides: Record<string, unknown> = {}) {
  await getDb(env)
    .insert(resolutions)
    .values({
      id,
      number: `R-2026-${id}`,
      title: `Resolution ${id}`,
      bodyMd: `Body text for ${id}.`,
      effectiveDate: '2026-01-15',
      status: 'in_force',
      adoptedByMotionId: null,
      supersedesId: null,
      visibility: 'public',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

function renderAs(
  container: Awaited<ReturnType<typeof makeContainer>>,
  role: 'visitor' | 'homeowner' | 'board',
  url = 'http://localhost/resolutions',
) {
  return container.renderToString(ResolutionsPage, {
    request: new Request(url),
    locals:
      role === 'visitor'
        ? undefined
        : ({
            authContext: {
              userId: 'u',
              role,
              propertyIds: [],
            },
          } as unknown as App.Locals),
  });
}

describe('/resolutions', () => {
  it('renders an in-force public resolution for a visitor', async () => {
    await seed('a', {
      status: 'in_force',
      visibility: 'public',
      number: 'R-2026-A',
      title: 'Parking Rules',
      bodyMd: 'No parking on the street overnight.',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('Residents Association Resolutions');
    expect(html).toContain('R-2026-A');
    expect(html).toContain('Parking Rules');
    expect(html).toContain('No parking on the street overnight.');
  });

  it('never renders a draft resolution, even for a board caller', async () => {
    await seed('draft1', {
      status: 'draft',
      visibility: 'board',
      number: 'R-2026-DRAFT',
      title: 'Not Yet Adopted',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'board');
    expect(html).not.toContain('R-2026-DRAFT');
    expect(html).not.toContain('Not Yet Adopted');
  });

  it('does not render a board-visibility resolution for a homeowner', async () => {
    await seed('boardonly', {
      status: 'in_force',
      visibility: 'board',
      number: 'R-2026-BOARD',
      title: 'Board Only Rule',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'homeowner');
    expect(html).not.toContain('R-2026-BOARD');
    expect(html).not.toContain('Board Only Rule');
  });

  it('hides superseded and repealed resolutions by default, and includes them under ?status=all', async () => {
    await seed('current', {
      status: 'in_force',
      visibility: 'public',
      number: 'R-2026-CURRENT',
      title: 'Current Rule',
    });
    await seed('old', {
      status: 'superseded',
      visibility: 'public',
      number: 'R-2025-OLD',
      title: 'Old Superseded Rule',
    });
    await seed('gone', {
      status: 'repealed',
      visibility: 'public',
      number: 'R-2024-GONE',
      title: 'Repealed Rule',
    });
    const container = await makeContainer();

    const defaultHtml = await renderAs(container, 'visitor');
    expect(defaultHtml).toContain('R-2026-CURRENT');
    expect(defaultHtml).not.toContain('R-2025-OLD');
    expect(defaultHtml).not.toContain('R-2024-GONE');
    // The plain-link, no-JS toggle to the ?status=all view — pins that the
    // link itself exists on the default render, not just that the target
    // URL behaves correctly once reached by hand.
    expect(defaultHtml).toContain(
      'Show superseded and repealed resolutions too',
    );

    const allHtml = await renderAs(
      container,
      'visitor',
      'http://localhost/resolutions?status=all',
    );
    expect(allHtml).toContain('R-2026-CURRENT');
    expect(allHtml).toContain('R-2025-OLD');
    expect(allHtml).toContain('R-2024-GONE');
  });

  it('renders "an earlier resolution" for a public resolution superseding a board-only one, leaking neither the hidden number nor its title', async () => {
    await seed('hidden', {
      status: 'superseded',
      visibility: 'board',
      number: 'R-2020-HIDDEN',
      title: 'Secret Board Rule',
    });
    await seed('current', {
      status: 'in_force',
      visibility: 'public',
      number: 'R-2026-CURRENT',
      title: 'Public Successor Rule',
      supersedesId: 'hidden',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    expect(html).toContain('an earlier resolution');
    // These two are cheap regression insurance against a call-site swap
    // (e.g. back to fetchAdminResolutions), NOT proof the page masks a
    // visible chain link correctly: fetchResolutionsFor already nulled
    // `number`/`title` on this link at the read layer (reads.ts) before the
    // page ever saw it, so a page that concatenated the masked (null) fields
    // straight into the "an earlier resolution" string would still pass
    // both of these. The positive control below is what actually proves the
    // masking, by rendering the SAME fixture to a caller who is in tier for
    // it.
    expect(html).not.toContain('R-2020-HIDDEN');
    expect(html).not.toContain('Secret Board Rule');

    // Positive control: the hidden fixture's identity is real and DOES
    // render for a caller in tier, so the visitor assertions above are the
    // absence of a present value, not the absence of an empty fixture. This
    // also exercises the chain's visible=true branch, which no other test
    // covers.
    const boardHtml = await renderAs(container, 'board');
    expect(boardHtml).toContain('R-2020-HIDDEN — Secret Board Rule');
    expect(boardHtml).not.toContain('an earlier resolution');
  });

  it('renders bodyMd through ReportMarkdown', async () => {
    await seed('md', {
      status: 'in_force',
      visibility: 'public',
      number: 'R-2026-MD',
      title: 'Markdown Body Rule',
      bodyMd: '## Section\n\n- One\n- Two\n\n**Bold text** here.',
    });
    const container = await makeContainer();
    const html = await renderAs(container, 'visitor');
    // ReportMarkdown turns "## Section" into a real <h2> and the bullets into
    // a real <ul>/<li> list — confirms the body goes through the renderer
    // rather than being dropped in as a raw, unrendered markdown string.
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<li>One</li>');
    expect(html).toContain('<li>Two</li>');
    expect(html).toContain('<strong>Bold text</strong>');
  });
});
