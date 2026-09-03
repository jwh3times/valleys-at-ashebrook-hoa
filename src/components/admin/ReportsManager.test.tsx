import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ReportsManager from './ReportsManager';

function sse(frames: [string, unknown][]): Response {
  const body = frames
    .map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => vi.unstubAllGlobals());

const LIST = [
  {
    id: 'r1',
    topic: 'Rentals & leasing',
    templateKey: 'rentals',
    createdAt: '2026-07-30T12:00:00.000Z',
    createdBy: 'u1',
  },
];

function listPage(items = LIST, nextCursor: string | null = null) {
  return { items, nextCursor };
}

describe('ReportsManager', () => {
  it('shows an empty state when no reports are saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(listPage([]))),
    );
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText(/no reports yet/i)).toBeInTheDocument(),
    );
  });

  it('lists saved reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(listPage())),
    );
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText('Rentals & leasing')).toBeInTheDocument(),
    );
  });

  it('loads the next page of saved reports on demand', async () => {
    const older = {
      ...LIST[0],
      id: 'r2',
      topic: 'Older report',
      createdAt: '2026-07-29T12:00:00.000Z',
    };
    const mock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(listPage(LIST, 'cursor-2')))
      .mockResolvedValueOnce(Response.json(listPage([older])));
    vi.stubGlobal('fetch', mock);

    render(<ReportsManager />);
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Older report')).toBeInTheDocument();
    expect(mock).toHaveBeenLastCalledWith(
      '/api/admin/reports?limit=20&cursor=cursor-2',
    );
    expect(
      screen.queryByRole('button', { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the six template cards and a freeform topic box on New report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(listPage([]))),
    );
    render(<ReportsManager />);
    fireEvent.click(await screen.findByRole('button', { name: /new report/i }));
    expect(screen.getByText('Rentals & leasing')).toBeInTheDocument();
    expect(screen.getByText('Meetings & voting')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/own topic/i)).toBeInTheDocument();
  });

  it('POSTs the template key, streams tokens, then shows the saved report', async () => {
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toEqual({
          template: 'rentals',
        });
        return sse([
          [
            'sources',
            [
              {
                id: 'doc-1',
                title: 'CCRs',
                category: 'Governing Documents',
                href: '/api/files/doc-1',
              },
            ],
          ],
          ['token', { text: '## Summary\nRestricted.' }],
          ['done', { id: 'new-id' }],
        ]);
      }
      return Response.json(listPage([]));
    });
    vi.stubGlobal('fetch', mock);
    render(<ReportsManager />);
    fireEvent.click(await screen.findByRole('button', { name: /new report/i }));
    fireEvent.click(screen.getByRole('button', { name: /rentals & leasing/i }));
    await waitFor(() =>
      expect(screen.getByText('Restricted.')).toBeInTheDocument(),
    );
    // Asserts the transition into the saved-report view specifically (not
    // just that the streamed text is still on screen from `generating`):
    // a real link with the expected href, a Delete control, and no more
    // "Generating…" indicator.
    const link = screen.getByRole('link', { name: 'CCRs' });
    expect(link).toHaveAttribute('href', '/api/files/doc-1');
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    expect(screen.queryByText(/generating…/i)).not.toBeInTheDocument();
  });

  it('deletes a report from the history list without opening it', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    let listCalls = 0;
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        expect(JSON.parse(init.body as string)).toEqual({ id: 'r1' });
        return new Response(null, { status: 200 });
      }
      listCalls += 1;
      return Response.json(listPage(listCalls === 1 ? LIST : []));
    });
    vi.stubGlobal('fetch', mock);
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText('Rentals & leasing')).toBeInTheDocument(),
    );
    const deleteBtn = screen.getByRole('button', {
      name: 'Delete Rentals & leasing',
    });
    fireEvent.click(deleteBtn);
    expect(confirm).toHaveBeenCalledWith(
      'Delete "Rentals & leasing"? This cannot be undone.',
    );
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        '/api/admin/reports',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/no reports yet/i)).toBeInTheDocument(),
    );
    // Stayed on the list view rather than navigating into a report view.
    expect(screen.queryByText(/^Generated /)).not.toBeInTheDocument();
  });

  it('does not delete from the history list when the confirmation is declined', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        throw new Error('DELETE should not have been called');
      }
      return Response.json(listPage());
    });
    vi.stubGlobal('fetch', mock);
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText('Rentals & leasing')).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Rentals & leasing' }),
    );
    expect(confirm).toHaveBeenCalled();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
      false,
    );
    // Still on the list view with the report still present.
    expect(screen.getByText('Rentals & leasing')).toBeInTheDocument();
  });

  it('deletes a report from the detail view after confirming', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    let listCalls = 0;
    const mock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        expect(JSON.parse(init.body as string)).toEqual({ id: 'r1' });
        return new Response(null, { status: 200 });
      }
      if (typeof url === 'string' && url.includes('id=r1')) {
        return Response.json({
          id: 'r1',
          topic: 'Rentals & leasing',
          templateKey: 'rentals',
          createdAt: '2026-07-30T12:00:00.000Z',
          createdBy: 'u1',
          contentMd: '## Summary\nDetail body.',
          sources: [],
        });
      }
      listCalls += 1;
      return Response.json(listPage(listCalls === 1 ? LIST : []));
    });
    vi.stubGlobal('fetch', mock);
    render(<ReportsManager />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Rentals & leasing' }),
    );
    await waitFor(() =>
      expect(screen.getByText('Detail body.')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(confirm).toHaveBeenCalledWith(
      'Delete "Rentals & leasing"? This cannot be undone.',
    );
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        '/api/admin/reports',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('surfaces a stream error without saving UI state', async () => {
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST')
        return sse([
          ['sources', []],
          ['error', { message: 'Report generation failed.' }],
        ]);
      return Response.json(listPage([]));
    });
    vi.stubGlobal('fetch', mock);
    render(<ReportsManager />);
    fireEvent.click(await screen.findByRole('button', { name: /new report/i }));
    fireEvent.click(screen.getByRole('button', { name: /rentals & leasing/i }));
    await waitFor(() =>
      expect(screen.getByText(/generation failed/i)).toBeInTheDocument(),
    );
  });
});
