import { useEffect, useState } from 'react';
import { fetchDuesSettings } from '../../lib/content';
import { isFirebaseConfigured } from '../../lib/firebase';
import { DEFAULT_DUES_SETTINGS, type DuesSettings } from '../../lib/types';

export default function DuesInfo() {
  const [dues, setDues] = useState<DuesSettings | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setDues(DEFAULT_DUES_SETTINGS);
      return;
    }
    fetchDuesSettings()
      .then(setDues)
      .catch(() => setDues(DEFAULT_DUES_SETTINGS));
  }, []);

  if (dues === null)
    return <p className="loading">Loading dues information…</p>;

  return (
    <div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Annual Dues</h2>
        <p style={{ fontSize: '1.3rem', fontWeight: 700, margin: '0.25rem 0' }}>
          {dues.amount}
        </p>
        {dues.dueDate && <p className="muted">{dues.dueDate}</p>}
        {dues.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{dues.notes}</p>}
      </div>

      <h2>Payment Options</h2>
      {dues.paymentOptions.length === 0 ? (
        <p className="muted">
          Payment options will be listed here soon. Please contact the board for
          details.
        </p>
      ) : (
        <div className="grid grid--2">
          {dues.paymentOptions.map((opt, i) => (
            <div key={i} className="card">
              <h3 style={{ marginTop: 0 }}>{opt.label}</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{opt.details}</p>
              {opt.url && (
                <a
                  className="btn"
                  href={opt.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Pay with {opt.label} →
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
