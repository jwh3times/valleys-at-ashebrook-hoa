import { useEffect, useState } from 'react';
import {
  fetchMembers,
  fetchProperties,
  fetchRosterPeople,
  memberAction,
} from '../../lib/admin';
import {
  acceptCorrectionRequest,
  acceptVerificationRequest,
  declineCorrectionRequest,
  declineVerificationRequest,
  fetchCorrectionRequests,
  fetchVerificationRequests,
} from '../../lib/roster-admin';
import type {
  CorrectionRequestRow,
  VerificationReviewRequestRow,
} from '../../lib/roster-admin';
import { formatDate } from '../../lib/format';
import type {
  MembersView,
  ManualApprovalItem,
  MemberUser,
  PropertyWithOwners,
} from '../../lib/types';

/** Best-effort default: match a claimed address to an active home by a
 * case-insensitive compare of trimmed strings. Returns '' when unsure. */
function defaultHomeId(claimed: string, homes: PropertyWithOwners[]): string {
  const c = claimed.trim().toLowerCase();
  const hit = homes.find((h) => h.address.trim().toLowerCase() === c);
  return hit?.id ?? '';
}

/** The new-model routes return epoch milliseconds, not the ISO strings the
 * legacy admin API returns. Same rendered shape as `formatDate`, local time. */
function formatMs(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

type RosterPerson = { partyId: string; displayName: string };

export default function MembersManager() {
  const [data, setData] = useState<MembersView>({ recent: [], queue: [] });
  const [homes, setHomes] = useState<PropertyWithOwners[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [requests, setRequests] = useState<VerificationReviewRequestRow[]>([]);
  const [corrections, setCorrections] = useState<CorrectionRequestRow[]>([]);
  const [people, setPeople] = useState<RosterPerson[]>([]);
  const [personPicks, setPersonPicks] = useState<Record<string, string>>({});
  const [requestsError, setRequestsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    const [members, props] = await Promise.all([
      fetchMembers(),
      fetchProperties(),
    ]);
    const active = props.filter((h) => h.status === 'active');
    setHomes(active);
    setData(members);
    setPicks(
      Object.fromEntries(
        members.queue.map((q) => [
          q.id,
          defaultHomeId(q.claimedAddress, active),
        ]),
      ),
    );
    // The new-model queue is loaded separately so that a failure there — the
    // roster read is empty until the flip's backfill runs, and either route
    // could 403 — still leaves the legacy sections usable.
    try {
      const [open, corrs, roster] = await Promise.all([
        fetchVerificationRequests(),
        fetchCorrectionRequests(),
        fetchRosterPeople(),
      ]);
      setRequests(open);
      setCorrections(corrs.filter((c) => c.status === 'open'));
      setPeople(roster);
      setPersonPicks({});
      setRequestsError('');
    } catch (err: any) {
      setRequests([]);
      setCorrections([]);
      setRequestsError(err?.message ?? 'Could not load member requests.');
    }
    setLoading(false);
  }
  useEffect(() => {
    void load();
  }, []);

  async function act(
    payload: Parameters<typeof memberAction>[0],
    okMsg: string,
  ) {
    setMsg('');
    try {
      await memberAction(payload);
      setMsg(okMsg);
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'action failed.'));
    }
  }

  async function approve(q: ManualApprovalItem) {
    const propertyId = picks[q.id];
    if (!propertyId) {
      setMsg('Pick a home to link before approving.');
      return;
    }
    await act(
      { action: 'approve', queueId: q.id, propertyId },
      'Request approved.',
    );
  }

  /** Both verification-request actions: the route's plain-text refusals ("This
   * Person is already linked to an account — unlink it first") are the only
   * thing the board can act on, so they are surfaced verbatim. */
  async function requestAction(fn: () => Promise<unknown>, okMsg: string) {
    setMsg('');
    try {
      await fn();
      setMsg(okMsg);
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'action failed.'));
    }
  }

  async function accept(r: VerificationReviewRequestRow) {
    const personId = personPicks[r.id];
    if (!personId) {
      setMsg('Pick the person this account belongs to before accepting.');
      return;
    }
    await requestAction(
      () => acceptVerificationRequest({ id: r.id, personId }),
      'Verification request accepted.',
    );
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Members</h1>
      </div>
      <p className="admin-panel__intro">
        Homeowner verification requests awaiting a board decision, and current
        homeowners. Accepting links the account to the person it belongs to;
        revoking returns them to visitor access.
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

      <div className="panel-editor__title">Verification requests</div>
      <p className="admin-panel__intro">
        Residents who asked the board to verify them by hand. Accepting records
        the person they are; declining is permanently recorded on the account's
        history.
      </p>
      <div className="panel-list" style={{ marginBottom: '26px' }}>
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : requestsError ? (
          <p className="muted panel-pad">Error: {requestsError}</p>
        ) : requests.length === 0 ? (
          <p className="muted panel-pad">No verification requests.</p>
        ) : (
          requests.map((r) => (
            <div key={r.id} className="list-row">
              <div className="admin-row-date">{formatMs(r.createdAt)}</div>
              <div className="admin-row-main">
                <div className="admin-row-title">
                  {r.accountEmail ?? r.accountId}
                </div>
                <div className="admin-row-sub">
                  Claimed: {r.claimedName} — {r.claimedAddress}
                </div>
                <label
                  htmlFor={`person-${r.id}`}
                  className="sr-only"
                >{`Person for ${r.accountEmail ?? r.accountId}`}</label>
                <select
                  id={`person-${r.id}`}
                  value={personPicks[r.id] ?? ''}
                  onChange={(e) =>
                    setPersonPicks({ ...personPicks, [r.id]: e.target.value })
                  }
                >
                  <option value="">Select a person…</option>
                  {people.map((p) => (
                    <option key={p.partyId} value={p.partyId}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row-actions">
                <button className="row-link" onClick={() => accept(r)}>
                  Accept
                </button>
                <button
                  className="row-link row-link--danger"
                  onClick={() =>
                    requestAction(
                      () => declineVerificationRequest(r.id),
                      'Verification request declined.',
                    )
                  }
                >
                  Decline
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel-editor__title">Correction requests</div>
      <p className="admin-panel__intro">
        Members asking to correct their own name or contact details. Accepting
        records the corrected fact as an ordinary roster change; declining
        leaves no record on the ledger.
      </p>
      <div className="panel-list" style={{ marginBottom: '26px' }}>
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : requestsError ? (
          <p className="muted panel-pad">Error: {requestsError}</p>
        ) : corrections.length === 0 ? (
          <p className="muted panel-pad">No correction requests.</p>
        ) : (
          corrections.map((c) => (
            <div key={c.id} className="list-row">
              <div className="admin-row-date">{formatMs(c.createdAt)}</div>
              <div className="admin-row-main">
                <div className="admin-row-title">{c.personDisplayName}</div>
                <div className="admin-row-sub">
                  {c.kind === 'name'
                    ? `Name: "${c.proposedValue}"`
                    : `Contact (${c.channel ?? c.targetChannel ?? 'contact'}): ` +
                      (c.targetCurrentValue
                        ? `${c.targetCurrentValue} → ${c.proposedValue}`
                        : `"${c.proposedValue}" (new)`)}
                </div>
                {c.note && <div className="admin-row-sub">Note: {c.note}</div>}
              </div>
              <div className="row-actions">
                <button
                  className="row-link"
                  aria-label={`Accept correction from ${c.personDisplayName}`}
                  onClick={() =>
                    requestAction(
                      () => acceptCorrectionRequest(c.id),
                      'Correction accepted.',
                    )
                  }
                >
                  Accept
                </button>
                <button
                  className="row-link row-link--danger"
                  aria-label={`Decline correction from ${c.personDisplayName}`}
                  onClick={() =>
                    requestAction(
                      () => declineCorrectionRequest(c.id),
                      'Correction declined.',
                    )
                  }
                >
                  Decline
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Leftovers from before the verification queue above existed: the
          manual approval queue has had no writer since v0.10.0, so the whole
          section is hidden once its last row is cleared. */}
      {!loading && data.queue.length > 0 && (
        <>
          <div className="panel-editor__title">
            Pending requests (legacy queue)
          </div>
          <p className="admin-panel__intro">
            Older requests from before verification requests moved to the queue
            above. Nothing new arrives here; approving still links the person to
            a home.
          </p>
          <div className="panel-list" style={{ marginBottom: '26px' }}>
            {data.queue.map((q) => (
              <div key={q.id} className="list-row">
                <div className="admin-row-date">{formatDate(q.createdAt)}</div>
                <div className="admin-row-main">
                  <div className="admin-row-title">{q.email ?? q.userId}</div>
                  <div className="admin-row-sub">
                    Claimed: {q.claimedAddress} — {q.reason}
                  </div>
                  <label
                    htmlFor={`home-${q.id}`}
                    className="sr-only"
                  >{`Home for ${q.email ?? q.userId}`}</label>
                  <select
                    id={`home-${q.id}`}
                    value={picks[q.id] ?? ''}
                    onChange={(e) =>
                      setPicks({ ...picks, [q.id]: e.target.value })
                    }
                  >
                    <option value="">Select a home…</option>
                    {homes.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.address}
                        {h.unit ? ` · Unit ${h.unit}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row-actions">
                  <button className="row-link" onClick={() => approve(q)}>
                    Approve
                  </button>
                  <button
                    className="row-link row-link--danger"
                    onClick={() =>
                      act({ action: 'deny', queueId: q.id }, 'Request denied.')
                    }
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="panel-editor__title">Recent homeowners</div>
      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : data.recent.length === 0 ? (
          <p className="muted panel-pad">None yet.</p>
        ) : (
          data.recent.map((u: MemberUser) => (
            <div key={u.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{u.name}</div>
                <div className="admin-row-sub">{u.email}</div>
              </div>
              <div className="row-actions">
                <button
                  className="row-link row-link--danger"
                  onClick={() =>
                    act(
                      { action: 'revoke', userId: u.id },
                      'Homeowner access revoked.',
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
