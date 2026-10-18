import { useCallback, useEffect, useState } from 'react';
import {
  DRIVE_OUTCOME_MESSAGES,
  disconnectDrive,
  driveConnectHref,
  fetchDriveStatus,
  type DriveStatus,
} from '../../lib/drive';

// #290 slice 2 (spec decision 8, ADR 0027): the association's Google Drive
// connection. Board admins see its status; only a System Administrator may
// connect, reconnect or disconnect it.

const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString() : 'never';

const DISCONNECT_WARNING =
  "Disconnect Google Drive? The site loses access to the association's Google Drive until it is connected again. Documents already imported stay. Google keeps its record of which files were shared with the site, so reconnecting the same account restores access to them.";

const MANUAL_REVOKE =
  "Disconnected. Google didn't confirm removing the site's access, so remove it yourself: in the association Google account, open Security → Your connections to third-party apps & services, and remove the site.";

/** The `?drive=` outcome Google's redirect brought back, read once. */
function takeOutcome(): string | null {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('drive');
  if (!outcome) return null;
  params.delete('drive');
  const rest = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${rest ? `?${rest}` : ''}`,
  );
  return DRIVE_OUTCOME_MESSAGES[outcome] ?? null;
}

/**
 * The connection's status, loaded on mount in the documented mount-fetch shape
 * (AGENTS.md): a memoized loader as the effect's dependency, an unmount flag
 * guarding the write, and a `reload` for after Disconnect.
 */
function useDriveStatus() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const loadStatus = useCallback(
    () => fetchDriveStatus().catch((): DriveStatus | null => null),
    [],
  );
  useEffect(() => {
    let live = true;
    async function start() {
      const loaded = await loadStatus();
      if (live) setStatus(loaded);
    }
    void start();
    return () => {
      live = false;
    };
  }, [loadStatus]);
  const reload = useCallback(async () => {
    setStatus(await loadStatus());
  }, [loadStatus]);
  return { status, reload };
}

export default function DriveConnectionCard() {
  const { status, reload } = useDriveStatus();
  const [message, setMessage] = useState<string | null>(() => takeOutcome());
  const [busy, setBusy] = useState(false);

  if (!status) return null;

  async function handleDisconnect() {
    if (!confirm(DISCONNECT_WARNING)) return;
    setBusy(true);
    try {
      const { revokeFailed } = await disconnectDrive();
      setMessage(
        revokeFailed ? MANUAL_REVOKE : 'Google Drive is disconnected.',
      );
    } catch (err) {
      setMessage(
        'Error: ' +
          (err instanceof Error ? err.message : 'could not disconnect.'),
      );
    } finally {
      setBusy(false);
      await reload();
    }
  }

  return (
    <div
      className="panel-card"
      id="drive-connection"
      style={{ maxWidth: '620px', marginTop: '24px' }}
    >
      <h2>Google Drive connection</h2>
      {message && <div className="form-message">{message}</div>}
      {status.status === 'none' && (
        <p>
          Not connected. Board admins can't import from Google Drive until a
          System Administrator connects the association's Google account.
        </p>
      )}
      {status.status === 'connected' && (
        <p>
          Connected to <strong>{status.googleEmail}</strong> by{' '}
          {status.connectedByName ?? 'a former account'} on{' '}
          {when(status.connectedAt)}. Last used {when(status.lastUsedAt)}; last
          checked {when(status.lastRefreshedAt)}.
        </p>
      )}
      {status.status === 'broken' && (
        <p>
          The connection to <strong>{status.googleEmail}</strong> stopped
          working on {when(status.brokenAt)}. Imports are unavailable until it
          is reconnected.
        </p>
      )}
      {status.canManage ? (
        <div className="btn-row">
          {status.status === 'none' ? (
            <a className="btn" href={driveConnectHref(false)}>
              Connect Google Drive
            </a>
          ) : (
            <>
              <a className="btn" href={driveConnectHref(true)}>
                Reconnect
              </a>
              <button
                className="btn btn--outline"
                disabled={busy}
                onClick={handleDisconnect}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="muted">
          Only a System Administrator can connect or disconnect Google Drive.
        </p>
      )}
    </div>
  );
}

/** One line above Documents, for the System Administrators who can fix it. */
export function DriveStatusLine() {
  const { status } = useDriveStatus();
  if (!status?.canManage) return null;
  const text =
    status.status === 'connected'
      ? `Google Drive: connected as ${status.googleEmail}.`
      : status.status === 'broken'
        ? 'Google Drive: the connection stopped working.'
        : 'Google Drive: not connected.';
  return (
    <p className="muted panel-pad">
      {text}{' '}
      <a
        href="/admin?section=site"
        aria-label="Manage the Google Drive connection"
      >
        Manage
      </a>
    </p>
  );
}
