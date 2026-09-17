import { fetchSiteSettings } from '../../lib/content';
import { saveSite, setSiteGate } from '../../lib/admin';
import {
  DEFAULT_SITE_SETTINGS,
  SITE_GATE_KEYS,
  type SiteGateKey,
  type SiteSettings,
} from '../../lib/types';
import { useAdminResource } from './useAdminResource';

/**
 * #363: these two gates no longer travel through the whole-blob `PUT` —
 * the server preserves whatever is stored for them regardless of what this
 * form sends. Each toggle instead calls the audited compare-and-swap
 * transition directly, with the value the form loaded with as `expected`,
 * so a stale tab cannot revert a gate someone else already changed.
 */
const GATE_COPY: Record<SiteGateKey, { label: string; help: string }> = {
  officialMode: {
    label: 'Official mode',
    help: 'When off, the site presents as an unofficial resident-run hub: it shows a “not affiliated with the HOA” disclaimer and hides the dues and board features. Turn this on only if the HOA board formally adopts this site.',
  },
  liveVotingEnabled: {
    label: 'Live voting',
    help: 'Enables homeowner election ballots and member-motion votes. Turning this off pauses every open vote without closing it or deleting received votes.',
  },
};

export default function SiteManager() {
  const {
    data: site,
    setData: setSite,
    loading,
    busy,
    msg,
    run,
    reload,
  } = useAdminResource<SiteSettings>(fetchSiteSettings, DEFAULT_SITE_SETTINGS);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await run(() => saveSite(site), 'Site settings saved.');
  }

  function toggleGate(key: SiteGateKey, next: boolean) {
    const expected = site[key];
    void run(
      async () => {
        // Reload even on a conflict: the checkbox must settle back to
        // whatever is actually stored, not the click the caller just made.
        try {
          await setSiteGate(key, expected, next);
        } finally {
          await reload();
        }
      },
      `${GATE_COPY[key].label} turned ${next ? 'on' : 'off'}.`,
    );
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

      <div
        className="panel-card"
        style={{ maxWidth: '620px', marginBottom: '18px' }}
      >
        {SITE_GATE_KEYS.map((key, i) => (
          <div
            className="field"
            style={{ margin: i === 0 ? 0 : '18px 0 0' }}
            key={key}
          >
            <label
              style={{ display: 'flex', gap: '10px', alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={site[key]}
                disabled={busy}
                aria-label={`Turn ${GATE_COPY[key].label} ${site[key] ? 'off' : 'on'}`}
                onChange={(e) => toggleGate(key, e.target.checked)}
              />
              <span>{GATE_COPY[key].label}</span>
            </label>
            <p style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>
              {GATE_COPY[key].help}
            </p>
          </div>
        ))}
      </div>

      <div className="panel-card" style={{ maxWidth: '620px' }}>
        <div className="field">
          <label htmlFor="site-welcome-heading">
            Welcome heading (home page)
          </label>
          <input
            id="site-welcome-heading"
            type="text"
            value={site.welcomeHeading}
            onChange={(e) =>
              setSite({ ...site, welcomeHeading: e.target.value })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="site-welcome-body">Welcome text (home page)</label>
          <textarea
            id="site-welcome-body"
            value={site.welcomeBody}
            onChange={(e) => setSite({ ...site, welcomeBody: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="site-contact-email">
            Public contact email (shown on Contact page)
          </label>
          <input
            id="site-contact-email"
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
