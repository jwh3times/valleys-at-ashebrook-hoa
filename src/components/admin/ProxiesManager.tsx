import { useEffect, useState } from 'react';
import {
  fetchProxies,
  saveProxy,
  deleteProxy,
  fetchProperties,
  fetchLotPeople,
  fetchMeetings,
  fetchElections,
} from '../../lib/admin';
import type { LotPeople } from '../../lib/admin';
import type {
  ProxyDetail,
  MeetingSummary,
  ElectionDetail,
  PropertyWithOwners,
} from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const emptyProxy = {
  propertyId: '',
  grantorPersonId: '',
  holderName: '',
  holderPersonId: '',
  occasionKind: 'meeting' as 'meeting' | 'election',
  occasionId: '',
};

export default function ProxiesManager() {
  const {
    data: proxies,
    loading,
    reload,
    busy,
    msg,
    run,
  } = useAdminResource<ProxyDetail[]>(fetchProxies, []);
  const [form, setForm] = useState(emptyProxy);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [properties, setProperties] = useState<PropertyWithOwners[]>([]);
  // Who may act for each lot — the roster's Lot Authority since #248 part 2,
  // including former holders so a historical paper proxy stays recordable.
  const [lotPeople, setLotPeople] = useState<LotPeople[]>([]);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [elections, setElections] = useState<ElectionDetail[]>([]);

  useEffect(() => {
    fetchProperties()
      .then(setProperties)
      .catch(() => {});
    fetchLotPeople()
      .then(setLotPeople)
      .catch(() => {});
    fetchMeetings()
      .then(setMeetings)
      .catch(() => {});
    fetchElections()
      .then(setElections)
      .catch(() => {});
  }, []);

  // Grouped by occasion — "who is covered for the March meeting" at a
  // glance, not a flat list. Meetings first (by date desc via the fetch
  // order), then elections, then any proxy whose occasion was deleted.
  const byMeeting = new Map<string, ProxyDetail[]>();
  const byElection = new Map<string, ProxyDetail[]>();
  for (const px of proxies) {
    if (px.meetingId) {
      byMeeting.set(px.meetingId, [...(byMeeting.get(px.meetingId) ?? []), px]);
    } else if (px.electionId) {
      byElection.set(px.electionId, [
        ...(byElection.get(px.electionId) ?? []),
        px,
      ]);
    }
  }
  const knownMeetingIds = new Set(meetings.map((m) => m.id));
  const knownElectionIds = new Set(elections.map((e) => e.id));
  // Proxies whose occasion no longer resolves against the loaded meeting/
  // election lists — the occasion tables CASCADE-delete their proxies, so
  // this should be empty in practice, but a proxy is never silently dropped
  // from the list if it somehow does happen.
  const orphaned = proxies.filter(
    (px) =>
      (px.meetingId != null && !knownMeetingIds.has(px.meetingId)) ||
      (px.electionId != null && !knownElectionIds.has(px.electionId)),
  );

  const grantorOptions =
    lotPeople.find((l) => l.lotId === form.propertyId)?.persons ?? [];
  // Every Person who has ever held any lot — the holder need not have any
  // connection to the lot whose proxy they hold, so this list is not scoped.
  const allPersons = [
    ...new Map(
      lotPeople
        .flatMap((l) => l.persons)
        .map((p) => [p.id, p] as const),
    ).values(),
  ];

  // The route deliberately accepts a grantor who no longer holds the lot, so
  // that a historical paper proxy can still be entered. Since the phase 3d
  // grantor re-validation, though, such a proxy is refused wherever it would
  // be USED (attendance, member votes, ballots) — so say so at entry rather
  // than let the board discover it months later.
  const selectedGrantor = grantorOptions.find(
    (p) => p.id === form.grantorPersonId,
  );
  const grantorInactive = selectedGrantor !== undefined && !selectedGrantor.current;

  function resetForm() {
    setForm(emptyProxy);
    setEditingId(null);
  }

  function startEdit(px: ProxyDetail) {
    setEditingId(px.id);
    setForm({
      propertyId: px.propertyId,
      grantorPersonId: px.grantorPersonId,
      holderName: px.holderName,
      holderPersonId: px.holderPersonId ?? '',
      occasionKind: px.meetingId ? 'meeting' : 'election',
      occasionId: px.meetingId ?? px.electionId ?? '',
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const done = editingId ? 'Proxy updated.' : 'Proxy recorded.';
    void run(async () => {
      if (editingId) {
        await saveProxy(
          {
            grantorPersonId: form.grantorPersonId,
            holderName: form.holderName,
            holderPersonId: form.holderPersonId || null,
          },
          editingId,
        );
      } else {
        await saveProxy({
          propertyId: form.propertyId,
          grantorPersonId: form.grantorPersonId,
          holderName: form.holderName,
          holderPersonId: form.holderPersonId || null,
          meetingId: form.occasionKind === 'meeting' ? form.occasionId : null,
          electionId: form.occasionKind === 'election' ? form.occasionId : null,
        });
      }
      resetForm();
      await reload();
    }, done);
  }

  function remove(px: ProxyDetail) {
    // confirm() BEFORE run() — the run wrapper flips `busy`, and a dialog
    // inside it would hold the whole panel busy while the prompt sits open.
    if (!window.confirm(`Delete the proxy for ${px.address}?`)) return;
    void run(async () => {
      await deleteProxy(px.id);
      await reload();
    }, 'Proxy deleted.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Proxies</h1>
      </div>
      <p className="admin-panel__intro">
        Paper proxy assignments recorded against a meeting or an election — who
        stands in for a lot, and for which occasion. A lot may have at most one
        proxy per occasion.
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

      <form
        className="panel-card"
        onSubmit={submit}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">
          {editingId ? 'Edit Proxy' : 'Add Proxy'}
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="proxy-occasion-kind">Occasion type</label>
            <select
              id="proxy-occasion-kind"
              value={form.occasionKind}
              onChange={(e) =>
                setForm({
                  ...form,
                  occasionKind: e.target.value as 'meeting' | 'election',
                  occasionId: '',
                })
              }
              disabled={busy || editingId !== null}
            >
              <option value="meeting">Meeting</option>
              <option value="election">Election</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="proxy-occasion">
              {form.occasionKind === 'meeting' ? 'Meeting' : 'Election'}
            </label>
            <select
              id="proxy-occasion"
              value={form.occasionId}
              onChange={(e) => setForm({ ...form, occasionId: e.target.value })}
              required
              disabled={busy || editingId !== null}
            >
              <option value="">— choose —</option>
              {form.occasionKind === 'meeting'
                ? meetings
                    // Only member meetings take proxies — the route 409s a
                    // board-body meeting (PR 7a); the grouped record list
                    // below is deliberately NOT filtered, so a legacy row
                    // never vanishes from view.
                    .filter((m) => m.body === 'member')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.date} — {m.title}
                      </option>
                    ))
                : elections.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.electionDate} — {e.title}
                    </option>
                  ))}
            </select>
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="proxy-property">Property</label>
            <select
              id="proxy-property"
              value={form.propertyId}
              onChange={(e) =>
                setForm({
                  ...form,
                  propertyId: e.target.value,
                  grantorPersonId: '',
                })
              }
              required
              disabled={busy || editingId !== null}
            >
              <option value="">— choose a lot —</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.address}
                  {p.unit ? ` ${p.unit}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="proxy-grantor">Grantor (owner or representative)</label>
            <select
              id="proxy-grantor"
              value={form.grantorPersonId}
              onChange={(e) =>
                setForm({ ...form, grantorPersonId: e.target.value })
              }
              required
              disabled={!form.propertyId}
            >
              <option value="">— choose a person —</option>
              {grantorOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.fullName}
                  {o.current ? '' : ' (no longer holds this lot)'}
                </option>
              ))}
            </select>
            {grantorInactive && (
              <p
                className="form-message form-message--error"
                role="alert"
                style={{ marginTop: '8px' }}
              >
                {selectedGrantor?.fullName} does not currently hold authority
                for this lot. The proxy can still be recorded for the paper
                record, but it cannot be used: attendance, votes, and ballots
                refuse a proxy whose grantor no longer holds the lot.
              </p>
            )}
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="proxy-holder-name">Proxy holder name</label>
            <input
              id="proxy-holder-name"
              type="text"
              value={form.holderName}
              onChange={(e) => setForm({ ...form, holderName: e.target.value })}
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="proxy-holder-owner">
              Holder is also on the roster (optional)
            </label>
            <select
              id="proxy-holder-owner"
              value={form.holderPersonId}
              onChange={(e) =>
                setForm({ ...form, holderPersonId: e.target.value })
              }
            >
              <option value="">— none —</option>
              {allPersons.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.fullName}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add Proxy'}
          </button>
          {editingId && (
            <button
              className="btn btn--small btn--ghost"
              type="button"
              onClick={resetForm}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : proxies.length === 0 ? (
          <p className="muted panel-pad">No proxies recorded yet.</p>
        ) : (
          <>
            {meetings
              .filter((m) => byMeeting.has(m.id))
              .map((m) => (
                <div key={`meeting-${m.id}`} style={{ marginBottom: '22px' }}>
                  <h2 style={{ marginBottom: '10px' }}>
                    {m.date} — {m.title}
                  </h2>
                  {byMeeting.get(m.id)!.map((px) => (
                    <ProxyRow
                      key={px.id}
                      px={px}
                      onEdit={() => startEdit(px)}
                      onDelete={() => remove(px)}
                    />
                  ))}
                </div>
              ))}
            {elections
              .filter((e) => byElection.has(e.id))
              .map((e) => (
                <div key={`election-${e.id}`} style={{ marginBottom: '22px' }}>
                  <h2 style={{ marginBottom: '10px' }}>
                    {e.electionDate} — {e.title}
                  </h2>
                  {byElection.get(e.id)!.map((px) => (
                    <ProxyRow
                      key={px.id}
                      px={px}
                      onEdit={() => startEdit(px)}
                      onDelete={() => remove(px)}
                    />
                  ))}
                </div>
              ))}
            {orphaned.length > 0 && (
              <div style={{ marginBottom: '22px' }}>
                <h2 style={{ marginBottom: '10px' }}>Unknown occasion</h2>
                {orphaned.map((px) => (
                  <ProxyRow
                    key={px.id}
                    px={px}
                    onEdit={() => startEdit(px)}
                    onDelete={() => remove(px)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ProxyRow({
  px,
  onEdit,
  onDelete,
}: {
  px: ProxyDetail;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="panel-card" style={{ marginBottom: '14px' }}>
      <div className="list-row">
        <div className="admin-row-main">
          <div className="admin-row-title">
            {px.address} — {px.grantorName} → {px.holderName}
          </div>
        </div>
        <div className="row-actions">
          <button
            className="row-link"
            aria-label={`Edit proxy for ${px.address}`}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            className="row-link row-link--danger"
            aria-label={`Delete proxy for ${px.address}`}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
