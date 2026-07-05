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
