import { useState } from 'react';
import { CONTACT_INPUT_LIMITS } from '../../lib/types';
import { useTenancyAction } from './useTenancyAction';

// The request form on `/tenants` (#294 slice 3): ask the board to approve a
// tenant for one of the caller's Lots. The page renders it only while both
// gates are on.

interface Props {
  lots: { lotId: string; address: string }[];
  /** The end-day bounds: after today, and at most the policy's months out. */
  minEndDay: string;
  maxEndDay: string;
}

export default function TenancyRequestForm({
  lots,
  minEndDay,
  maxEndDay,
}: Props) {
  const { busy, error, run } = useTenancyAction();
  const [lotId, setLotId] = useState(lots[0]?.lotId ?? '');
  const [tenantName, setTenantName] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [contact, setContact] = useState('');
  const [scheduledEndDay, setScheduledEndDay] = useState('');

  return (
    <form
      className="panel-card"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          {
            action: 'request',
            lotId,
            tenantName,
            channel,
            contact,
            scheduledEndDay,
          },
          'request',
        );
      }}
    >
      <h2>Ask the board to approve a tenant</h2>
      {error && (
        <div className="form-message form-message--error" role="alert">
          {error}
        </div>
      )}
      {lots.length > 1 && (
        <label>
          Lot
          <select value={lotId} onChange={(e) => setLotId(e.target.value)}>
            {lots.map((l) => (
              <option key={l.lotId} value={l.lotId}>
                {l.address}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Tenant’s full name
        <input
          required
          maxLength={200}
          value={tenantName}
          onChange={(e) => setTenantName(e.target.value)}
        />
      </label>
      <label>
        Contact by
        <select
          value={channel}
          onChange={(e) =>
            setChannel(e.target.value === 'sms' ? 'sms' : 'email')
          }
        >
          <option value="email">Email</option>
          <option value="sms">Text message</option>
        </select>
      </label>
      <label>
        {channel === 'email' ? 'Email address' : 'Mobile number'}
        <input
          required
          type={channel === 'email' ? 'email' : 'tel'}
          maxLength={CONTACT_INPUT_LIMITS[channel]}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
      </label>
      <label>
        Access ends on
        <input
          required
          type="date"
          min={minEndDay}
          max={maxEndDay}
          value={scheduledEndDay}
          onChange={(e) => setScheduledEndDay(e.target.value)}
        />
      </label>
      <p className="muted">
        Any day after today, up to {maxEndDay}. The board sees the name and
        contact you give; a refused or withdrawn request keeps neither.
      </p>
      <button type="submit" disabled={busy}>
        Ask the board
      </button>
    </form>
  );
}
