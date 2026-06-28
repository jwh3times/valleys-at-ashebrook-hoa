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

  if (loading) return <p className="loading">Loading…</p>;

  return (
    <form onSubmit={handleSave}>
      <h2>Site &amp; contact settings</h2>
      {msg && <div className="form-message form-message--success">{msg}</div>}
      <div className="card">
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
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}
