import { fetchSiteSettings } from '../../lib/content';
import { saveSite } from '../../lib/admin';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

export default function SiteManager() {
  const {
    data: site,
    setData: setSite,
    loading,
    busy,
    msg,
    run,
  } = useAdminResource<SiteSettings>(fetchSiteSettings, DEFAULT_SITE_SETTINGS);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await run(() => saveSite(site), 'Site settings saved.');
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
        <div className="field">
          <label htmlFor="site-disclaimer">Unofficial-site disclaimer</label>
          <textarea
            id="site-disclaimer"
            value={site.disclaimerText}
            onChange={(e) =>
              setSite({ ...site, disclaimerText: e.target.value })
            }
            placeholder="Leave blank to use the built-in disclaimer."
          />
          <p style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>
            Shown in the footer only when official mode is off. Leave blank to
            use the built-in text.
          </p>
        </div>
        <div className="field">
          <label htmlFor="site-about">About page text</label>
          <textarea
            id="site-about"
            rows={8}
            value={site.aboutBody}
            onChange={(e) => setSite({ ...site, aboutBody: e.target.value })}
            placeholder="Leave blank to use the built-in About copy."
          />
          <p style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>
            The public About page. Separate paragraphs with a blank line. Leave
            blank to use the built-in text.
          </p>
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
