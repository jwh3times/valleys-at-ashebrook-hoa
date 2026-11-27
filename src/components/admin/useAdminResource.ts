import { useCallback, useEffect, useState } from 'react';

function messageOf(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message ?? fallback;
}

/**
 * Shared scaffolding for the admin managers: loads a resource on mount and
 * exposes the load/busy/message state each manager was repeating by hand.
 *
 * - `data`/`setData` + `loading` + `loadError` + `reload()` — the resource and
 *   its load state.
 * - `busy` + `msg` + `setMsg` + `run(action, successMsg)` — a save/delete action
 *   wrapper with uniform success and `"Error: …"` handling.
 *
 * A failed load records `loadError` AND writes the same text into `msg`, so
 * every manager surfaces it through the message banner it already renders
 * without needing its own error branch. `reload()` still rethrows after
 * recording, because the managers call it from inside `run()` after a write —
 * swallowing there would report "Saved." over a list that never refreshed.
 */
export function useAdminResource<T>(fetcher: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // useCallback so the mount effect can declare `load` as its dependency.
  // Every caller passes a module-level fetcher, so this is stable and the
  // effect runs once on mount; an inline fetcher would reload every render.
  // `isStale` lets the mount load drop a response that lands after unmount.
  const load = useCallback(
    async (isStale: () => boolean) => {
      setLoading(true);
      setLoadError('');
      try {
        const next = await fetcher();
        if (isStale()) return;
        setData(next);
      } catch (err: unknown) {
        if (isStale()) return;
        const message = messageOf(err, 'could not load.');
        setLoadError(message);
        setMsg('Error: ' + message);
        throw err;
      } finally {
        // In `finally` so a rejected fetcher can't strand the manager on
        // "Loading…" forever, which is what an unguarded `await` did here.
        if (!isStale()) setLoading(false);
      }
    },
    [fetcher],
  );

  async function reload() {
    await load(() => false);
  }

  useEffect(() => {
    // React's documented mount-fetch shape: the load is started from a
    // function declared inside the effect and guarded by `ignore`, which the
    // cleanup flips so a late response can't write state. The rejection is
    // already recorded in loadError/msg by load(); catching it here only
    // keeps it from surfacing as an unhandled rejection.
    let ignore = false;
    async function loadOnMount() {
      await load(() => ignore).catch(() => {});
    }
    void loadOnMount();
    return () => {
      ignore = true;
    };
  }, [load]);

  /** Runs `action`, then shows `successMsg`, or the message the action
   * returns when the outcome needs saying more exactly. */
  async function run(action: () => Promise<string | void>, successMsg: string) {
    setBusy(true);
    setMsg('');
    try {
      const said = await action();
      setMsg(typeof said === 'string' ? said : successMsg);
    } catch (err: unknown) {
      setMsg('Error: ' + messageOf(err, 'could not save.'));
    } finally {
      setBusy(false);
    }
  }

  return {
    data,
    setData,
    loading,
    loadError,
    reload,
    busy,
    msg,
    setMsg,
    run,
  };
}
