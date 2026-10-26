import { useState } from 'react';
import { tenancyAction, type TenancyAction } from '../../lib/member';

// The shared half of the `/tenants` islands (#294 slice 3). The page renders
// the list on the server, so a successful action reloads it, carrying which
// action succeeded for the page's confirmation; a refused one stays put and
// shows the server's reason.

export type TenancyDone = 'request' | 'renew' | 'withdraw' | 'end';

export function useTenancyAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: TenancyAction, done: TenancyDone): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await tenancyAction(body);
    } catch (e) {
      setError(`Error: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
      return;
    }
    window.location.assign(`/tenants?done=${done}`);
  }

  return { busy, error, run };
}
