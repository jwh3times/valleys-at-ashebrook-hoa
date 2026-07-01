import { useEffect, useState } from 'react';
import { fetchDuesSettings } from '../../lib/content';
import { DEFAULT_DUES_SETTINGS, type DuesSettings } from '../../lib/types';

export default function DuesInfo() {
  const [dues, setDues] = useState<DuesSettings | null>(null);

  useEffect(() => {
    fetchDuesSettings()
      .then(setDues)
      .catch(() => setDues(DEFAULT_DUES_SETTINGS));
  }, []);

  if (dues === null)
    return <p className="loading">Loading dues information…</p>;

  const hasOptions = dues.paymentOptions.length > 0;

  return (
    <div className="dues-grid">
      <div className="dues-card">
        <p className="eyebrow eyebrow--onnavy">Annual Assessment</p>
        <div className="dues-card__amount">{dues.amount}</div>
        <div className="dues-card__sub">per household</div>
        {(dues.dueDate || dues.notes) && <hr />}
        {dues.dueDate && (
          <div className="dues-card__row">
            <span className="dues-card__dot" aria-hidden="true" />
            <span>{dues.dueDate}</span>
          </div>
        )}
        {dues.notes && <div className="dues-card__note">{dues.notes}</div>}
      </div>

      <div>
        <h2 className="side-h2" style={{ fontSize: '20px' }}>
          How to Pay
        </h2>
        {!hasOptions ? (
          <p className="muted">
            Payment options will be listed here soon. Please contact the board
            for details.
          </p>
        ) : (
          <>
            <div className="pay-grid">
              {dues.paymentOptions.map((opt, i) => (
                <div key={i} className="pay-card">
                  <h3 className="pay-card__name">{opt.label}</h3>
                  {opt.details && (
                    <p className="pay-card__detail">{opt.details}</p>
                  )}
                  {opt.url && (
                    <a
                      className="pay-card__handle"
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
            <div className="callout" style={{ marginTop: '20px' }}>
              Please include your <strong>street address</strong> in the payment
              note so the treasurer can record it correctly.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
