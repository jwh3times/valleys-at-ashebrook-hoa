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

describe('ReportsManager', () => {
  it('shows an empty state when no reports are saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText(/no reports yet/i)).toBeInTheDocument(),
    );
  });

  it('lists saved reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(LIST)),
    );
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText('Rentals & leasing')).toBeInTheDocument(),
    );
  });

  it('shows the six template cards and a freeform topic box on New report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );
    render(<ReportsManager />);
    fireEvent.click(await screen.findByRole('button', { name: /new report/i }));
    expect(screen.getByText('Rentals & leasing')).toBeInTheDocument();
    expect(screen.getByText('Meetings & voting')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/own topic/i)).toBeInTheDocument();
  });

  it('POSTs the template key, streams tokens, then shows the saved report', async () => {
    const mock = vi.fn(async (url: unknown, init?: RequestInit) => {
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
      return Response.json([]);
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
    let listCalls = 0;
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        expect(JSON.parse(init.body as string)).toEqual({ id: 'r1' });
        return new Response(null, { status: 200 });
      }
      listCalls += 1;
      return Response.json(listCalls === 1 ? LIST : []);
    });
    vi.stubGlobal('fetch', mock);
    render(<ReportsManager />);
    await waitFor(() =>
      expect(screen.getByText('Rentals & leasing')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
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

  it('surfaces a stream error without saving UI state', async () => {
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST')
        return sse([
          ['sources', []],
          ['error', { message: 'Report generation failed.' }],
        ]);
      return Response.json([]);
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
