import {
  endTenancy,
  fetchTenancies,
  voidTenancy,
  type AdminTenancy,
} from '../../lib/roster-admin';
import { useAdminResource } from './useAdminResource';

// The board's Tenants panel (ADR 0028, #294). It lists every Tenancy and can
// end or void one. Both actions take effect whether or not tenant access is
// switched on, because ending access must never wait on a setting.

const END_REASON_LABELS: Record<string, string> = {
  owner_ended: 'ended by the owner',
  board_ended: 'ended by the board',
  basis_ended: "the owner's ownership ended",
  lot_retired: 'the lot was retired',
};

function describe(t: AdminTenancy): string {
  switch (t.status) {
    case 'current':
      return `Current, ${t.startDay} to ${t.scheduledEndDay}`;
    case 'upcoming':
      return `Starts ${t.startDay}, ends ${t.scheduledEndDay}`;
    case 'voided':
      return 'Voided (recorded in error)';
    case 'ended':
      // No recorded end means it reached its scheduled end, or its basis
      // ended without the end being recorded on it.
      return t.actualEndDay
        ? `Ended ${t.actualEndDay}: ${END_REASON_LABELS[t.endReason ?? ''] ?? t.endReason}`
        : `Ended (scheduled to end ${t.scheduledEndDay})`;
  }
}

export default function TenantsPanel() {
  const {
    data: tenancies,
    loading,
    reload,
    busy,
    msg,
    run,
  } = useAdminResource<AdminTenancy[]>(fetchTenancies, []);

  function end(t: AdminTenancy) {
    // confirm() BEFORE run(): the wrapper holds the panel busy while it runs.
    if (
      !window.confirm(
        `End ${t.tenantName}'s tenancy at ${t.address} today? They lose access to Tenant-Visible documents at once.`,
      )
    )
      return;
    void run(async () => {
      await endTenancy(t.id);
      await reload();
    }, 'Tenancy ended.');
  }

  function voidOne(t: AdminTenancy) {
    if (
      !window.confirm(
        `Void ${t.tenantName}'s tenancy at ${t.address}? Use this only for a tenancy recorded in error.`,
      )
    )
      return;
    void run(async () => {
      await voidTenancy(t.id);
      await reload();
    }, 'Tenancy voided.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Tenants</h1>
      </div>
      <p className="admin-panel__intro">
        A tenancy lets a tenant read the documents marked Tenant-Visible, until
        its end day or until the owner&apos;s ownership ends. Ending or voiding
        one takes effect at once, whether or not tenant access is switched on.
      </p>

      {msg && (
        <div
          className={
            msg.startsWith('Error:')
              ? 'form-message form-message--error'
              : 'form-message form-message--success'
          }
        >
          {msg}
        </div>
      )}

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : tenancies.length === 0 ? (
          <p className="muted panel-pad">No tenancies recorded yet.</p>
        ) : (
          tenancies.map((t) => (
            <div
              key={t.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">
                    {t.address} — {t.tenantName}
                  </div>
                  <div className="muted">{describe(t)}</div>
                </div>
                <div className="row-actions">
                  {(t.status === 'current' || t.status === 'upcoming') && (
                    <button
                      className="row-link"
                      aria-label={`End tenancy: ${t.tenantName}, ${t.address}`}
                      disabled={busy}
                      onClick={() => end(t)}
                    >
                      End
                    </button>
                  )}
                  {t.status !== 'voided' && (
                    <button
                      className="row-link row-link--danger"
                      aria-label={`Void tenancy: ${t.tenantName}, ${t.address}`}
                      disabled={busy}
                      onClick={() => voidOne(t)}
                    >
                      Void
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
