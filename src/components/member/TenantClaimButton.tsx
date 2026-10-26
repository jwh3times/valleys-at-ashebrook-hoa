import { useState } from 'react';
import { claimTenancy } from '../../lib/member';

// The one action on `/tenant-invite` (#294 slice 4). The page only displays;
// this POST is what consumes the invitation. On success the tenant lands on
// the documents the board marked for tenants.

export default function TenantClaimButton({
  token,
  address,
}: {
  token: string;
  address: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClaim() {
    setBusy(true);
    setError(null);
    try {
      await claimTenancy(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    window.location.assign('/documents');
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        aria-label={`Claim tenant access: ${address}`}
        onClick={onClaim}
      >
        Claim tenant access
      </button>
      {error && (
        <p className="form-message form-message--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
