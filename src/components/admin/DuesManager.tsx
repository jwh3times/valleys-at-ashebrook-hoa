import { fetchDuesSettings } from '../../lib/content';
import { saveDues } from '../../lib/admin';
import {
  DEFAULT_DUES_SETTINGS,
  type DuesSettings,
  type PaymentOption,
} from '../../lib/types';
import { useAdminResource } from './useAdminResource';

export default function DuesManager() {
  const {
    data: dues,
    setData: setDues,
    loading,
    busy,
    msg,
    run,
  } = useAdminResource<DuesSettings>(fetchDuesSettings, DEFAULT_DUES_SETTINGS);

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
      paymentOptions: [
        ...prev.paymentOptions,
        { label: '', details: '', url: '' },
      ],
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
    const cleaned: DuesSettings = {
      ...dues,
      paymentOptions: dues.paymentOptions.filter(
        (o) => o.label.trim() || o.details.trim(),
      ),
    };
    await run(async () => {
      await saveDues(cleaned);
      setDues(cleaned);
    }, 'Dues information saved.');
  }

  if (loading)
    return (
      <div className="admin-panel">
        <p className="loading">Loading…</p>
      </div>
    );

  return (
    <form className="admin-panel" onSubmit={handleSave}>
      <div className="admin-bar">
        <h1>Dues &amp; Payment Info</h1>
      </div>
      <p className="admin-panel__intro">
        Edit the amount, due date, and payment instructions shown on the public
        Dues page.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <div className="panel-card" style={{ marginBottom: '26px' }}>
        <div className="panel-editor__title">Amount &amp; schedule</div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Amount</label>
            <input
              type="text"
              value={dues.amount}
              onChange={(e) => setDues({ ...dues, amount: e.target.value })}
              placeholder="e.g. $250 / year"
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Due date / schedule</label>
            <input
              type="text"
              value={dues.dueDate}
              onChange={(e) => setDues({ ...dues, dueDate: e.target.value })}
              placeholder="e.g. Due by January 31"
            />
          </div>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Notes (late fees, etc.)</label>
          <textarea
            value={dues.notes}
            onChange={(e) => setDues({ ...dues, notes: e.target.value })}
          />
        </div>
      </div>

      <div className="admin-bar">
        <div className="panel-editor__title" style={{ margin: 0 }}>
          Payment options
        </div>
        <button
          type="button"
          className="btn btn--outline btn--small"
          onClick={addOption}
        >
          + Add option
        </button>
      </div>

      {dues.paymentOptions.length === 0 && (
        <p className="muted" style={{ marginTop: 0 }}>
          No payment options yet. Add one above.
        </p>
      )}

      {dues.paymentOptions.map((opt, i) => (
        <div key={i} className="panel-card" style={{ marginBottom: '14px' }}>
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Label</label>
              <input
                type="text"
                value={opt.label}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                placeholder="e.g. PayPal, Venmo, Zelle, Check"
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Button link (optional)</label>
              <input
                type="url"
                value={opt.url ?? ''}
                onChange={(e) => updateOption(i, { url: e.target.value })}
                placeholder="https://paypal.me/..."
              />
            </div>
          </div>
          <div className="field" style={{ marginBottom: '14px' }}>
            <label>Details / instructions</label>
            <textarea
              value={opt.details}
              onChange={(e) => updateOption(i, { details: e.target.value })}
              placeholder="Handle, address, or instructions"
            />
          </div>
          <button
            type="button"
            className="row-link row-link--danger"
            onClick={() => removeOption(i)}
          >
            Remove option
          </button>
        </div>
      ))}

      <div className="btn-row" style={{ marginTop: '20px' }}>
        <button className="btn btn--small" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save dues information'}
        </button>
      </div>
    </form>
  );
}
