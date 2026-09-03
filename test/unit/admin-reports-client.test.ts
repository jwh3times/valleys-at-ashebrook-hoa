import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchReports, fetchReport, deleteReport } from '../../src/lib/admin';

afterEach(() => vi.unstubAllGlobals());

describe('reports client helpers', () => {
  it('fetchReports GETs the list endpoint', async () => {
    const mock = vi.fn(async () =>
      Response.json({
        items: [
          {
            id: 'r1',
            topic: 'Rentals & leasing',
            templateKey: 'rentals',
            createdAt: '2026-07-31T00:00:00.000Z',
            createdBy: 'u1',
          },
        ],
        nextCursor: 'next-page',
      }),
    );
    vi.stubGlobal('fetch', mock);
    const page = await fetchReports();
    expect(mock).toHaveBeenCalledWith('/api/admin/reports?limit=20');
    expect(page.items[0].id).toBe('r1');
    expect(page.nextCursor).toBe('next-page');
  });

  it('fetchReports carries an opaque cursor to the next page', async () => {
    const mock = vi.fn(async () =>
      Response.json({ items: [], nextCursor: null }),
    );
    vi.stubGlobal('fetch', mock);
    await fetchReports('cursor/+ value');
    expect(mock).toHaveBeenCalledWith(
      '/api/admin/reports?limit=20&cursor=cursor%2F%2B+value',
    );
  });

  it('fetchReport GETs by id and throws on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not found', { status: 404 })),
    );
    await expect(fetchReport('nope')).rejects.toThrow();
  });

  it('deleteReport sends DELETE with the id in the body', async () => {
    const mock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mock);
    await deleteReport('r1');
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/reports');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'r1' });
  });
});
