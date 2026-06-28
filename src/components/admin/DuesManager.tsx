import { useEffect, useState } from 'react';
import { fetchDuesSettings } from '../../lib/content';
import { saveDues } from '../../lib/admin';
import {
  DEFAULT_DUES_SETTINGS,
  type DuesSettings,
  type PaymentOption,
} from '../../lib/types';

export default function DuesManager() {
  const [dues, setDues] = useState<DuesSettings>(DEFAULT_DUES_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetchDuesSettings().then((d) => {
      setDues(d);
      setLoading(false);
    });
  }, []);

  function updateOption(i: number, patch: Partial<PaymentOption>) {
    setDues((prev) => ({
      ...prev,
      paymentOptions: prev.paymentOptions.map((o, idx) =>
        idx === i ? { ...o, ...patch } : o,
      ),
    }));
  }

  function addOption() {
    setDues((prev) => ({
      ...prev,
      paymentOptions: [...prev.paymentOptions, { label: '', details: '', url: '' }],
    }));
  }

  function removeOption(i: number) {
    setDues((prev) => ({
      ...prev,
      paymentOptions: prev.paymentOptions.filter((_, idx) => idx !== i),
    }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      // Drop empty payment options before saving.
      const cleaned: DuesSettings = {
        ...dues,
        paymentOptions: dues.paymentOptions.filter(
          (o) => o.label.trim() || o.details.trim(),
        ),
      };
      await saveDues(cleaned);
      setDues(cleaned);
      setMsg('Dues information saved.');
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not save.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="loading">Loading…</p>;

  return (
    <form onSubmit={handleSave}>
      <h2>Dues information</h2>
      {msg && <div className="form-message form-message--success">{msg}</div>}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="field">
          <label>Amount</label>
          <input
            type="text"
            value={dues.amount}
            onChange={(e) => setDues({ ...dues, amount: e.target.value })}
            placeholder="e.g. $250 / year"
          />
        </div>
        <div className="field">
          <label>Due date / schedule</label>
          <input
            type="text"
            value={dues.dueDate}
            onChange={(e) => setDues({ ...dues, dueDate: e.target.value })}
            placeholder="e.g. Due by January 31 each year"
          />
        </div>
        <div className="field">
          <label>Notes (late fees, etc.)</label>
          <textarea
            value={dues.notes}
            onChange={(e) => setDues({ ...dues, notes: e.target.value })}
          />
        </div>
      </div>

      <div className="admin-bar">
        <h2 style={{ margin: 0 }}>Payment options</h2>
        <button type="button" className="btn btn--outline btn--small" onClick={addOption}>
          + Add option
        </button>
      </div>

      {dues.paymentOptions.length === 0 && (
        <p className="muted">No payment options yet. Add one above.</p>
      )}

      {dues.paymentOptions.map((opt, i) => (
        <div key={i} className="card" style={{ marginBottom: '1rem' }}>
          <div className="field">
            <label>Label</label>
            <input
              type="text"
              value={opt.label}
              onChange={(e) => updateOption(i, { label: e.target.value })}
              placeholder="e.g. PayPal, Venmo, Zelle, Mail a check"
            />
          </div>
          <div className="field">
            <label>Details / instructions</label>
            <textarea
              value={opt.details}
              onChange={(e) => updateOption(i, { details: e.target.value })}
              placeholder="Handle, address, or instructions"
            />
          </div>
          <div className="field">
            <label>Button link (optional)</label>
            <input
              type="url"
              value={opt.url ?? ''}
              onChange={(e) => updateOption(i, { url: e.target.value })}
              placeholder="https://paypal.me/..."
            />
          </div>
          <button
            type="button"
            className="btn btn--danger btn--small"
            onClick={() => removeOption(i)}
          >
            Remove option
          </button>
        </div>
      ))}

      <button className="btn" type="submit" disabled={busy} style={{ marginTop: '1rem' }}>
        {busy ? 'Saving…' : 'Save dues information'}
      </button>
    </form>
  );
}
