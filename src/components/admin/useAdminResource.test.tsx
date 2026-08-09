import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAdminResource } from './useAdminResource';

describe('useAdminResource', () => {
  it('loads the resource on mount (loading → data)', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 'a' }]);
    const { result } = renderHook(() => useAdminResource(fetcher, [] as any[]));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([{ id: 'a' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('run() sets busy while the action is in flight, then a success message', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    const { result } = renderHook(() => useAdminResource(fetcher, ''));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.run(async () => {}, 'Saved.');
    });
    expect(result.current.msg).toBe('Saved.');
    expect(result.current.busy).toBe(false);
  });

  it('run() reports a failure as an "Error: …" message and clears busy', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    const { result } = renderHook(() => useAdminResource(fetcher, ''));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.run(async () => {
        throw new Error('boom');
      }, 'Saved.');
    });
    expect(result.current.msg).toBe('Error: boom');
    expect(result.current.busy).toBe(false);
  });

  it('clears loading and reports the error when the mount load fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useAdminResource(fetcher, [] as any[]));

    // Without this the manager sits on "Loading…" forever.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe('network down');
    // Surfaced through the banner every manager already renders.
    expect(result.current.msg).toBe('Error: network down');
    expect(result.current.data).toEqual([]);
  });

  it('clears a previous loadError once a later load succeeds', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      useAdminResource(fetcher, '' as string),
    );
    await waitFor(() => expect(result.current.loadError).toBe('network down'));

    fetcher.mockResolvedValue('recovered');
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.loadError).toBe('');
    expect(result.current.data).toBe('recovered');
  });

  it('reload() rethrows so a run()-wrapped refresh is not reported as success', async () => {
    const fetcher = vi.fn().mockResolvedValue('one');
    const { result } = renderHook(() => useAdminResource(fetcher, ''));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetcher.mockRejectedValue(new Error('refresh failed'));
    await act(async () => {
      // The shape every manager uses: write, then refresh the list.
      await result.current.run(async () => {
        await result.current.reload();
      }, 'Saved.');
    });
    expect(result.current.msg).toBe('Error: refresh failed');
    expect(result.current.busy).toBe(false);
  });

  it('reload() re-runs the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue('one');
    const { result } = renderHook(() => useAdminResource(fetcher, ''));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetcher.mockResolvedValue('two');
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.data).toBe('two');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
