import { useEffect, useState } from 'react';

/**
 * Shared scaffolding for the admin managers: loads a resource on mount and
 * exposes the load/busy/message state each manager was repeating by hand.
 *
 * - `data`/`setData` + `loading` + `reload()` — the resource and its load state.
 * - `busy` + `msg` + `setMsg` + `run(action, successMsg)` — a save/delete action
 *   wrapper with uniform success and `"Error: …"` handling.
 */
export function useAdminResource<T>(fetcher: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function reload() {
    setLoading(true);
    setData(await fetcher());
    setLoading(false);
  }

  useEffect(() => {
    void reload();
    // Load once on mount, matching the managers' previous `useEffect(…, [])`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<void>, successMsg: string) {
    setBusy(true);
    setMsg('');
    try {
      await action();
      setMsg(successMsg);
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null)?.message ?? 'could not save.';
      setMsg('Error: ' + message);
    } finally {
      setBusy(false);
    }
  }

  return { data, setData, loading, reload, busy, msg, setMsg, run };
}
