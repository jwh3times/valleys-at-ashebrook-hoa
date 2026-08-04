import { useEffect, useState } from 'react';
import {
  fetchMyProxies,
  grantProxy,
  revokeProxy,
  lookupOwners,
} from '../../lib/member';
import type { OwnerLookupResult } from '../../lib/member';
import type {
  MemberLot,
  MemberProxyDetail,
  MemberProxyLists,
  UpcomingOccasion,
} from '../../lib/types';

interface Props {
  lots: MemberLot[];
  occasions: UpcomingOccasion[];
}

const emptyForm = {
  propertyId: '',
  grantorOwnerId: '',
  occasionKey: '', // `${kind}:${id}` — one select for both occasion kinds
  holderAddress: '',
  holderOwnerId: '',
};

export default function ProxyManager({ lots, occasions }: Props) {
  const [lists, setLists] = useState<MemberProxyLists>({
    granted: [],
    held: [],
  });
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(() => ({
    ...emptyForm,
    propertyId: lots.length === 1 ? lots[0].id : '',
    grantorOwnerId:
      lots.length === 1 && lots[0].owners.length === 1
        ? lots[0].owners[0].id
        : '',
  }));
  const [holderResult, setHolderResult] = useState<OwnerLookupResult | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function reload() {
    setLists(await fetchMyProxies());
    setLoading(false);
  }
  useEffect(() => {
    reload().catch(() => setLoading(false));
    // Load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grantorOptions =
    lots.find((l) => l.id === form.propertyId)?.owners ?? [];

  async function runLookup() {
    setBusy(true);
    setMsg(null);
    try {
      const result = await lookupOwners(form.holderAddress);
      setHolderResult(result);
      setForm((f) => ({
        ...f,
        holderOwnerId: result.owners.length === 1 ? result.owners[0].id : '',
      }));
    } catch (e) {
      setHolderResult(null);
      setMsg(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [kind, occasionId] = form.occasionKey.split(':');
    setBusy(true);
    setMsg(null);
    try {
      await grantProxy({
        propertyId: form.propertyId,
        grantorOwnerId: form.grantorOwnerId,
        holderOwnerId: form.holderOwnerId,
        meetingId: kind === 'meeting' ? occasionId : null,
        electionId: kind === 'election' ? occasionId : null,
      });
      setForm({ ...emptyForm, propertyId: form.propertyId });
      setHolderResult(null);
      setMsg('Proxy granted.');
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Grant failed');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(px: MemberProxyDetail) {
    if (!window.confirm(`Revoke the proxy for ${px.address}?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await revokeProxy(px.id);
      setMsg('Proxy revoked.');
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {msg && (
        <div
          className={
            /granted\.|revoked\./.test(msg)
              ? 'form-message form-message--success'
              : 'form-message form-message--error'
          }
        >
          {msg}
        </div>
      )}

      <form className="card" onSubmit={submit} style={{ marginBottom: '26px' }}>
        <h2 className="side-h2">Grant a proxy</h2>
        {occasions.length === 0 ? (
          <p className="muted">
            There are no upcoming meetings or elections to grant a proxy for
            right now.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="pm-lot">Your lot</label>
              <select
                id="pm-lot"
                value={form.propertyId}
                required
                onChange={(e) =>
                  setForm({
                    ...form,
                    propertyId: e.target.value,
                    grantorOwnerId: '',
                  })
                }
              >
                <option value="">— choose —</option>
                {lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.address}
                    {l.unit ? ` ${l.unit}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pm-grantor">You are</label>
              <select
                id="pm-grantor"
                value={form.grantorOwnerId}
                required
                disabled={!form.propertyId}
                onChange={(e) =>
                  setForm({ ...form, grantorOwnerId: e.target.value })
                }
              >
                <option value="">— choose your name —</option>
                {grantorOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pm-occasion">Occasion</label>
              <select
                id="pm-occasion"
                value={form.occasionKey}
                required
                onChange={(e) =>
                  setForm({ ...form, occasionKey: e.target.value })
                }
              >
                <option value="">— choose —</option>
                {occasions.map((o) => (
                  <option key={`${o.kind}:${o.id}`} value={`${o.kind}:${o.id}`}>
                    {o.date} — {o.title}
                    {o.kind === 'election' ? ' (election)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              {/* &#39; renders a plain apostrophe, so getByLabelText("Holder's
                  street address") in the tests matches exactly (a &rsquo; here
                  would be U+2019 and silently break the accessible-name match). */}
              <label htmlFor="pm-holder-address">
                Holder&#39;s street address
              </label>
              <input
                id="pm-holder-address"
                type="text"
                value={form.holderAddress}
                onChange={(e) =>
                  setForm({ ...form, holderAddress: e.target.value })
                }
              />
              <button
                className="btn btn--small btn--outline"
                type="button"
                disabled={busy || form.holderAddress.trim() === ''}
                onClick={runLookup}
              >
                Find owner
              </button>
            </div>
            {holderResult && (
              <div className="field">
                <label htmlFor="pm-holder">Proxy holder</label>
                <select
                  id="pm-holder"
                  value={form.holderOwnerId}
                  required
                  onChange={(e) =>
                    setForm({ ...form, holderOwnerId: e.target.value })
                  }
                >
                  <option value="">— choose —</option>
                  {holderResult.owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.fullName} — {holderResult.address}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="btn-row">
              <button
                className="btn btn--small"
                type="submit"
                disabled={busy || !form.holderOwnerId}
              >
                {busy ? 'Working…' : 'Grant proxy'}
              </button>
            </div>
          </>
        )}
      </form>

      <h2 className="side-h2">Proxies you have granted</h2>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : lists.granted.length === 0 ? (
        <p className="muted">No proxies granted.</p>
      ) : (
        lists.granted.map((px) => (
          <div className="card" key={px.id} style={{ marginBottom: '12px' }}>
            <p>
              {px.address}: {px.grantorName} → {px.holderName}
              {px.occasionTitle && (
                <>
                  {' '}
                  · {px.occasionDate} — {px.occasionTitle}
                </>
              )}
            </p>
            <button
              className="btn btn--small btn--outline"
              type="button"
              disabled={busy}
              aria-label={`Revoke proxy for ${px.address}`}
              onClick={() => revoke(px)}
            >
              Revoke
            </button>
          </div>
        ))
      )}

      <h2 className="side-h2">Proxies you hold</h2>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : lists.held.length === 0 ? (
        <p className="muted">You are not holding any proxies.</p>
      ) : (
        lists.held.map((px) => (
          <div className="card" key={px.id} style={{ marginBottom: '12px' }}>
            <p>
              {px.address}: {px.grantorName} → you
              {px.occasionTitle && (
                <>
                  {' '}
                  · {px.occasionDate} — {px.occasionTitle}
                </>
              )}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
