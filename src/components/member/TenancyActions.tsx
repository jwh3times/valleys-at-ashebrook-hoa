import { useState } from 'react';
import { useTenancyAction } from './useTenancyAction';

// The row actions of one Tenancy or open request on `/tenants` (#294 slices 3
// and 4). The row itself is server-rendered markup; this island carries only
// its buttons and the renewal's end-day form.

type Props =
  | {
      kind: 'tenancy';
      tenancyId: string;
      tenantName: string;
      address: string;
      /** The renewal's end-day bounds; null when it cannot be renewed. */
      renew: { minEndDay: string; maxEndDay: string } | null;
      /** Whether a fresh invitation may be sent: the tenant has not claimed
       * and tenant access is on (#294 slice 4). */
      reinvite: boolean;
    }
  | { kind: 'request'; requestId: string; tenantName: string; address: string };

export default function TenancyActions(props: Props) {
  const { busy, error, run } = useTenancyAction();
  const [renewing, setRenewing] = useState(false);
  const [renewUntil, setRenewUntil] = useState('');
  const subject = `${props.tenantName}, ${props.address}`;

  function end(tenancyId: string) {
    if (
      !window.confirm(
        `End ${props.tenantName}'s tenancy at ${props.address} today? They lose access at once.`,
      )
    )
      return;
    void run({ action: 'end', tenancyId }, 'end');
  }

  return (
    <div>
      <div className="row-actions">
        {props.kind === 'tenancy' ? (
          <>
            {props.renew && (
              <button
                type="button"
                className="row-link"
                aria-label={`Renew tenancy: ${subject}`}
                disabled={busy}
                onClick={() => setRenewing(true)}
              >
                Renew
              </button>
            )}
            {props.reinvite && (
              <button
                type="button"
                className="row-link"
                aria-label={`Re-invite tenant: ${subject}`}
                disabled={busy}
                onClick={() =>
                  void run(
                    { action: 'reinvite', tenancyId: props.tenancyId },
                    'reinvite',
                  )
                }
              >
                Re-invite
              </button>
            )}
            <button
              type="button"
              className="row-link row-link--danger"
              aria-label={`End tenancy: ${subject}`}
              disabled={busy}
              onClick={() => end(props.tenancyId)}
            >
              End
            </button>
          </>
        ) : (
          <button
            type="button"
            className="row-link"
            aria-label={`Withdraw tenancy request: ${subject}`}
            disabled={busy}
            onClick={() =>
              void run(
                { action: 'withdraw', requestId: props.requestId },
                'withdraw',
              )
            }
          >
            Withdraw
          </button>
        )}
      </div>
      {props.kind === 'tenancy' && props.renew && renewing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              {
                action: 'renew',
                tenancyId: props.tenancyId,
                scheduledEndDay: renewUntil,
              },
              'renew',
            );
          }}
        >
          <label>
            Renew until
            <input
              type="date"
              required
              min={props.renew.minEndDay}
              max={props.renew.maxEndDay}
              value={renewUntil}
              onChange={(e) => setRenewUntil(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Ask to renew
          </button>
        </form>
      )}
      {error && (
        <div className="form-message form-message--error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
