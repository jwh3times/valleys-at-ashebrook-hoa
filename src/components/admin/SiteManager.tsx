import { useEffect, useState } from 'react';
import { fetchSiteSettings } from '../../lib/content';
import { saveSite } from '../../lib/admin';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../lib/types';

export default function SiteManager() {
  const [site, setSite] = useState<SiteSettings>(DEFAULT_SITE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetchSiteSettings().then((s) => {
      setSite(s);
      setLoading(false);
    });
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      await saveSite(site);
      setMsg('Site settings saved.');
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not save.'));
    } finally {
      setBusy(false);
    }
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
        <h1>Site Settings</h1>
      </div>
      <p className="admin-panel__intro">
        Edit the headline and intro copy that appear across the public pages,
        plus the public contact email.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <div
        className="panel-card"
        style={{ maxWidth: '620px', marginBottom: '18px' }}
      >
        <div className="field" style={{ margin: 0 }}>
          <label style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={site.officialMode}
              onChange={(e) =>
                setSite({ ...site, officialMode: e.target.checked })
              }
            />
            <span>Official mode</span>
          </label>
          <p style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>
            When off, the site presents as an unofficial resident-run hub: it
            shows a “not affiliated with the HOA” disclaimer and hides the dues
            and board features. Turn this on only if the HOA board formally
            adopts this site.
          </p>
        </div>
      </div>

      <div className="panel-card" style={{ maxWidth: '620px' }}>
        <div className="field">
          <label>Welcome heading (home page)</label>
          <input
            type="text"
            value={site.welcomeHeading}
            onChange={(e) =>
              setSite({ ...site, welcomeHeading: e.target.value })
            }
          />
        </div>
        <div className="field">
          <label>Welcome text (home page)</label>
          <textarea
            value={site.welcomeBody}
            onChange={(e) => setSite({ ...site, welcomeBody: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Public contact email (shown on Contact page)</label>
          <input
            type="email"
            value={site.contactEmail}
            onChange={(e) => setSite({ ...site, contactEmail: e.target.value })}
            placeholder="valleysatashebrook@gmail.com"
          />
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </form>
  );
}
