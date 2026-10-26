import { useState } from 'react';
import {
  approveTenancyRequest,
  endTenancy,
  fetchRoster,
  fetchTenantsPanel,
  refuseTenancyRequest,
  reinviteTenancy,
  voidTenancy,
  type AdminRoster,
  type AdminTenancy,
  type AdminTenancyRequest,
  type ApprovalInvitation,
  type TenantsPanelData,
} from '../../lib/roster-admin';
import QueueDialog from './QueueDialog';
import RequestQueue from './RequestQueue';
import { useAdminResource } from './useAdminResource';

// The board's Tenants panel (ADR 0028, #294). Its queue holds owners' open
// requests, each approved or refused through a dialog (slice 3), and its list
// holds every Tenancy, which the board can end or void (slice 2), and
// re-invite while its tenant has not claimed (slice 4). Refuse, end and void
// take effect whether or not tenant access is switched on, because ending
// access, or clearing a pending request, must never wait on a setting; only
// Approve and Re-invite wait for it.

const MATCH_LABELS = {
  contact: 'already holds this contact',
  name: 'same name',
  search: 'found by search',
} as const;

const SEARCH_MIN = 2;
const SEARCH_LIMIT = 10;

interface Match {
  personId: string;
  name: string;
  matchedBy: keyof typeof MATCH_LABELS;
}

/**
 * The roster's unconsolidated People whose name, or one of whose current
 * contacts, contains `query`, apart from those in `exclude`. A phone query
 * matches on its digits, so `555-0142` finds `(555) 555-0142`.
 */
function searchRoster(
  roster: AdminRoster,
  query: string,
  exclude: Set<string>,
): Match[] {
  const q = query.trim().toLowerCase();
  if (q.length < SEARCH_MIN) return [];
  const qDigits = q.replace(/\D/g, '');
  const contactHolders = new Set(
    roster.contactMethods
      .filter(
        (c) =>
          c.value !== null &&
          !c.voided &&
          c.endDay === null &&
          (c.value.toLowerCase().includes(q) ||
            (c.channel === 'sms' &&
              qDigits.length >= 4 &&
              c.value.replace(/\D/g, '').includes(qDigits))),
      )
      .map((c) => c.partyId),
  );
  return roster.people
    .filter(
      (p) =>
        p.consolidatedIntoPartyId === null &&
        !exclude.has(p.partyId) &&
        ((!p.nameRedacted && p.displayName.toLowerCase().includes(q)) ||
          contactHolders.has(p.partyId)),
    )
    .slice(0, SEARCH_LIMIT)
    .map((p) => ({
      personId: p.partyId,
      name: p.displayName,
      matchedBy: 'search',
    }));
}

function describeRequest(r: AdminTenancyRequest): string {
  return [
    `${r.kind === 'renewal' ? 'Renewal' : 'New tenant'}, asked by ${r.requesterName}`,
    r.contact,
    `until ${r.scheduledEndDay}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

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

/** What the board is told after approving, by what happened to the
 * invitation (#294 slice 4). */
const APPROVED: Record<ApprovalInvitation, string> = {
  sent: 'Tenancy approved. The invitation is on its way to the tenant.',
  send_failed:
    'Tenancy approved, but the invitation could not be sent. Use Re-invite to try again.',
  rate_limited:
    "Tenancy approved, but today's invitation limit for it is reached. Use Re-invite tomorrow.",
  none: 'Tenancy approved.',
};

export default function TenantsPanel() {
  const {
    data: { tenancies, requests, approvalOpen },
    loading,
    reload,
    busy,
    msg,
    run,
  } = useAdminResource<TenantsPanelData>(fetchTenantsPanel, {
    tenancies: [],
    requests: [],
    approvalOpen: false,
  });
  const [approving, setApproving] = useState<AdminTenancyRequest | null>(null);
  // `null` records the tenant as a new Person.
  const [chosen, setChosen] = useState<Match | null>(null);
  const [search, setSearch] = useState('');
  // Read on the first search, then kept: the dialog searches it locally.
  const [roster, setRoster] = useState<AdminRoster | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<AdminTenancyRequest | null>(null);
  const [refusalReason, setRefusalReason] = useState('');

  function openApprove(r: AdminTenancyRequest) {
    setChosen(null);
    setSearch('');
    setApproving(r);
  }

  async function changeSearch(value: string) {
    setSearch(value);
    if (roster !== null || value.trim().length < SEARCH_MIN) return;
    try {
      setRoster(await fetchRoster());
      setSearchError(null);
    } catch (e) {
      setSearchError(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const listed: Match[] = approving?.candidates ?? [];
  const found =
    approving && roster
      ? searchRoster(roster, search, new Set(listed.map((c) => c.personId)))
      : [];
  // A search result the next keystroke filtered out is still the board's
  // choice, so it stays on the list.
  const options = [...listed, ...found];
  if (chosen && !options.some((m) => m.personId === chosen.personId))
    options.splice(listed.length, 0, chosen);

  function openRefuse(r: AdminTenancyRequest) {
    setRefusalReason('');
    setRefusing(r);
  }

  function approve() {
    const r = approving;
    if (!r) return;
    setApproving(null);
    void run(async () => {
      const invitation = await approveTenancyRequest(
        r.id,
        chosen?.personId ?? null,
      );
      await reload();
      return APPROVED[invitation];
    }, APPROVED.none);
  }

  function refuse() {
    const r = refusing;
    if (!r) return;
    setRefusing(null);
    void run(async () => {
      await refuseTenancyRequest(r.id, refusalReason.trim());
      await reload();
    }, 'Request refused.');
  }

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

  function reinvite(t: AdminTenancy) {
    void run(async () => {
      await reinviteTenancy(t.id);
      await reload();
    }, 'Invitation sent.');
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

      {!loading && !approvalOpen && requests.length > 0 && (
        <p className="muted">
          Tenant access is switched off, so requests can be refused but not
          approved.
        </p>
      )}

      {!loading && (
        <RequestQueue
          title="Requests waiting"
          emptyText="No requests waiting."
          items={requests}
          rowKey={(r) => r.id}
          rowTitle={(r) => `${r.address} — ${r.tenantName}`}
          rowDetail={describeRequest}
          rowNote={(r) =>
            r.basisEnded && (
              <div className="muted">
                The owner&apos;s ownership has ended, so this request can only
                be refused.
              </div>
            )
          }
          rowActions={(r) => (
            <>
              {approvalOpen && !r.basisEnded && (
                <button
                  className="row-link"
                  aria-label={`Approve tenancy request: ${r.tenantName}, ${r.address}`}
                  disabled={busy}
                  onClick={() => openApprove(r)}
                >
                  Approve
                </button>
              )}
              <button
                className="row-link row-link--danger"
                aria-label={`Refuse tenancy request: ${r.tenantName}, ${r.address}`}
                disabled={busy}
                onClick={() => openRefuse(r)}
              >
                Refuse
              </button>
            </>
          )}
        />
      )}

      {approving && (
        <QueueDialog
          title="Approve tenancy"
          confirmLabel="Approve"
          busy={busy}
          onConfirm={approve}
          onCancel={() => setApproving(null)}
        >
          <p>
            {approving.tenantName} at {approving.address}, until{' '}
            {approving.scheduledEndDay}.
          </p>
          {approving.kind === 'new' && (
            <fieldset>
              <legend>Who is the tenant?</legend>
              <label>
                <input
                  type="radio"
                  name="tenant-person"
                  checked={chosen === null}
                  onChange={() => setChosen(null)}
                />
                Record {approving.tenantName} as a new person
              </label>
              {options.map((c) => (
                <label key={c.personId}>
                  <input
                    type="radio"
                    name="tenant-person"
                    checked={chosen?.personId === c.personId}
                    onChange={() => setChosen(c)}
                  />
                  {c.name} — {MATCH_LABELS[c.matchedBy]}
                </label>
              ))}
            </fieldset>
          )}
          {approving.kind === 'new' && (
            <label>
              Search the roster by name or contact
              <input
                type="search"
                value={search}
                onChange={(e) => void changeSearch(e.target.value)}
              />
            </label>
          )}
          {approving.kind === 'new' && searchError && (
            <div className="form-message form-message--error">
              {searchError}
            </div>
          )}
          {approving.kind === 'new' &&
            roster &&
            search.trim().length >= SEARCH_MIN &&
            found.length === 0 && (
              <p className="muted">No one else on the roster matches.</p>
            )}
        </QueueDialog>
      )}

      {refusing && (
        <QueueDialog
          title="Refuse request"
          confirmLabel="Refuse"
          canConfirm={refusalReason.trim() !== ''}
          busy={busy}
          onConfirm={refuse}
          onCancel={() => setRefusing(null)}
        >
          <p>
            {refusing.tenantName} at {refusing.address}. The tenant&apos;s name
            and contact are cleared from the request.
          </p>
          <label>
            Reason (the owner sees this)
            <textarea
              maxLength={500}
              value={refusalReason}
              onChange={(e) => setRefusalReason(e.target.value)}
            />
          </label>
        </QueueDialog>
      )}

      <div className="panel-list">
        <h2>Tenancies</h2>
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
                  {approvalOpen &&
                    !t.claimed &&
                    (t.status === 'current' || t.status === 'upcoming') && (
                      <button
                        className="row-link"
                        aria-label={`Re-invite tenant: ${t.tenantName}, ${t.address}`}
                        disabled={busy}
                        onClick={() => reinvite(t)}
                      >
                        Re-invite
                      </button>
                    )}
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
