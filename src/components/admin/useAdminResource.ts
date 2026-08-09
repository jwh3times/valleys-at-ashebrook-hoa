import { useEffect, useState } from 'react';

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

  async function reload() {
    setLoading(true);
    setLoadError('');
    try {
      setData(await fetcher());
    } catch (err: unknown) {
      const message = messageOf(err, 'could not load.');
      setLoadError(message);
      setMsg('Error: ' + message);
      throw err;
    } finally {
      // In `finally` so a rejected fetcher can't strand the manager on
      // "Loading…" forever, which is what an unguarded `await` did here.
      setLoading(false);
    }
  }

  useEffect(() => {
    // Load once on mount, matching the managers' previous `useEffect(…, [])`.
    // The rejection is already recorded in loadError/msg by reload(); catching
    // it here only keeps it from surfacing as an unhandled rejection.
    void reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<void>, successMsg: string) {
    setBusy(true);
    setMsg('');
    try {
      await action();
      setMsg(successMsg);
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
