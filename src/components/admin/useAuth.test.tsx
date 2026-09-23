import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const session = vi.hoisted(() => ({
  data: null as { user: Record<string, unknown> } | null,
  isPending: false,
}));

vi.mock('../../lib/auth-client', () => ({
  authClient: { useSession: () => session },
}));

import { useAuth } from './useAuth';

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  session.data = null;
  session.isPending = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAuth', () => {
  it('asks nothing of the server when nobody is signed in', () => {
    const fetchMock = answer({});
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth());
    expect(result.current).toEqual({
      loading: false,
      user: null,
      isAdmin: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the board panels only when the derived context grants board', async () => {
    session.data = { user: { id: 'u1', email: 'a@example.com' } };
    vi.stubGlobal('fetch', answer({ capabilities: ['board', 'member'] }));
    const { result } = renderHook(() => useAuth());
    expect(result.current.loading).toBe(true);
    expect(result.current.isAdmin).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(true);
  });

  it("ignores the session's role mirror in both directions", async () => {
    session.data = { user: { id: 'u1', role: 'board' } };
    vi.stubGlobal('fetch', answer({ capabilities: ['member'] }));
    const denied = renderHook(() => useAuth());
    await waitFor(() => expect(denied.result.current.loading).toBe(false));
    expect(denied.result.current.isAdmin).toBe(false);

    session.data = { user: { id: 'u2', role: 'homeowner' } };
    vi.stubGlobal('fetch', answer({ capabilities: ['board'] }));
    const granted = renderHook(() => useAuth());
    await waitFor(() => expect(granted.result.current.loading).toBe(false));
    expect(granted.result.current.isAdmin).toBe(true);
  });

  it('fails closed when the context cannot be read', async () => {
    session.data = { user: { id: 'u1', role: 'board' } };
    vi.stubGlobal('fetch', answer('nope', 500));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    session.data = { user: { id: 'u2', role: 'board' } };
    const offline = renderHook(() => useAuth());
    await waitFor(() => expect(offline.result.current.loading).toBe(false));
    expect(offline.result.current.isAdmin).toBe(false);
  });

  it("re-reads when the signed-in account changes, never showing the last account's answer", async () => {
    session.data = { user: { id: 'u1' } };
    vi.stubGlobal('fetch', answer({ capabilities: ['board'] }));
    const { result, rerender } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isAdmin).toBe(true));

    session.data = { user: { id: 'u2' } };
    vi.stubGlobal('fetch', answer({ capabilities: [] }));
    rerender();
    // Until u2's own answer arrives, u1's grant must not carry over.
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });

  it('stays loading while the session itself is pending', () => {
    session.isPending = true;
    vi.stubGlobal('fetch', answer({}));
    const { result } = renderHook(() => useAuth());
    expect(result.current.loading).toBe(true);
    expect(result.current.isAdmin).toBe(false);
  });
});
