import { useEffect, useRef, useState } from 'react';
import type { AdminRoster } from '../../lib/roster-admin';
import { associationDateIso } from '../../lib/format';
import {
  previewOwnershipTransfer,
  commitOwnershipTransfer,
  type OwnershipTransferInput,
  type OwnershipTransferPreview,
} from '../../lib/ownership-transfer';
import {
  EvidenceFields,
  NO_EVIDENCE,
  ROSTER_KINDS,
  buildEvidence,
  type EvidenceState,
} from './RosterEvidenceFields';

export default function OwnershipTransferForm({
  roster,
  lotId,
  onCancel,
  onComplete,
}: {
  roster: AdminRoster;
  lotId: string;
  onCancel: () => void;
  onComplete: () => Promise<void>;
}) {
  const lot = roster.lots.find((row) => row.id === lotId)!;
  const owners = roster.ownerships.filter(
    (row) => row.lotId === lotId && row.current,
  );
  const parties = [
    ...roster.people.map((row) => ({
      id: row.partyId,
      label: row.displayName,
      consolidated: row.consolidatedIntoPartyId,
    })),
    ...roster.organizations.map((row) => ({
      id: row.partyId,
      label: row.displayName ?? row.legalName,
      consolidated: row.consolidatedIntoPartyId,
    })),
  ];
  const label = (id: string) =>
    parties.find((party) => party.id === id)?.label ?? id;
  const [departing, setDeparting] = useState<string[]>([]);
  const [incoming, setIncoming] = useState<string[]>([]);
  const [effectiveDay, setEffectiveDay] = useState(associationDateIso());
  const [evidence, setEvidence] = useState<EvidenceState>(NO_EVIDENCE);
  const [substitutions, setSubstitutions] = useState<Record<string, string>>(
    {},
  );
  const [termOptions, setTermOptions] = useState<
    OwnershipTransferPreview['boardTerms']
  >([]);
  const [preview, setPreview] = useState<OwnershipTransferPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const invalidate = () => {
    setPreview(null);
    setTermOptions([]);
    setSubstitutions({});
    setError('');
  };
  const input: OwnershipTransferInput = {
    lotId,
    departingOwnershipIds: departing,
    incomingPartyIds: incoming,
    effectiveDay,
    evidence: buildEvidence(evidence),
    substitutions: Object.entries(substitutions)
      .filter(([, id]) => id !== '')
      .map(([termId, qualifyingLotId]) => ({ termId, qualifyingLotId })),
  };
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  async function review(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const result = await previewOwnershipTransfer(input);
      if (mounted.current) {
        setPreview(result);
        setTermOptions(result.boardTerms);
      }
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : 'Preview failed');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!preview || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await commitOwnershipTransfer(input, preview.token);
      if (mounted.current) await onComplete();
    } catch (failure) {
      if (mounted.current) {
        setPreview(null);
        setError(
          failure instanceof Error ? failure.message : 'Transfer failed',
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="panel-card"
      aria-label={`Transfer ownership: ${lot.address}`}
      style={{ marginBottom: '26px' }}
    >
      <h2>Transfer ownership: {lot.address}</h2>
      <p>
        Select the owners leaving and arriving. Other co-owners keep their
        existing Ownerships.
      </p>
      <form onSubmit={review}>
        <fieldset disabled={busy}>
          <legend>Departing owners</legend>
          {owners.map((owner) => (
            <label key={owner.id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={departing.includes(owner.id)}
                onChange={() => {
                  invalidate();
                  setDeparting(toggle(departing, owner.id));
                }}
              />{' '}
              {label(owner.ownerPartyId)}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>Incoming owners</legend>
          <p className="muted">
            Create a new Person or Organization in the roster first if needed.
          </p>
          {parties
            .filter(
              (party) =>
                !party.consolidated &&
                !owners.some((owner) => owner.ownerPartyId === party.id),
            )
            .map((party) => (
              <label key={party.id} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={incoming.includes(party.id)}
                  onChange={() => {
                    invalidate();
                    setIncoming(toggle(incoming, party.id));
                  }}
                />{' '}
                {party.label}
              </label>
            ))}
        </fieldset>
        <div className="field">
          <label htmlFor="transfer-effective-day">Effective date</label>
          <input
            id="transfer-effective-day"
            type="date"
            value={effectiveDay}
            max={associationDateIso()}
            required
            disabled={busy}
            onChange={(event) => {
              invalidate();
              setEffectiveDay(event.target.value);
            }}
          />
          <p className="muted">
            Departing owners end on this date; incoming owners start on this
            date.
          </p>
        </div>
        <EvidenceFields
          idPrefix="transfer"
          kinds={ROSTER_KINDS}
          value={evidence}
          disabled={busy}
          onChange={(value) => {
            invalidate();
            setEvidence(value);
          }}
        />
        {termOptions.map((term) => (
          <div className="field" key={term.termId}>
            <label htmlFor={`transfer-term-${term.termId}`}>
              Board-qualifying Lot for {term.displayName}
            </label>
            <select
              id={`transfer-term-${term.termId}`}
              value={substitutions[term.termId] ?? ''}
              disabled={busy}
              onChange={(event) => {
                setSubstitutions({
                  ...substitutions,
                  [term.termId]: event.target.value,
                });
                setPreview(null);
                setError('');
              }}
            >
              <option value="">End or cancel this Board Term</option>
              {term.availableLots.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.address}
                </option>
              ))}
            </select>
            <p className="muted">
              After changing a substitution, review the transfer again.
            </p>
          </div>
        ))}
        <button
          className="btn btn--small"
          disabled={busy || departing.length === 0 || incoming.length === 0}
          type="submit"
        >
          {busy ? 'Working…' : 'Review transfer'}
        </button>
        <button
          className="btn btn--small btn--outline"
          disabled={busy}
          type="button"
          onClick={onCancel}
        >
          Cancel transfer
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div aria-label="Transfer review" style={{ marginTop: '20px' }}>
          <h3>Review transfer</h3>
          <p>
            <strong>{preview.address}</strong> — effective{' '}
            {preview.effectiveDay}
          </p>
          <p>
            Departing:{' '}
            {preview.departing.map((party) => party.displayName).join(', ')}.
          </p>
          <p>
            Incoming:{' '}
            {preview.incoming.map((party) => party.displayName).join(', ')}.
          </p>
          <p>
            Unchanged co-owners:{' '}
            {preview.retained.map((party) => party.displayName).join(', ') ||
              'None'}
            .
          </p>
          <p>
            Lot Authority ends for:{' '}
            {preview.authorityLost
              .map((party) => party.displayName)
              .join(', ') || 'Nobody'}
            .
          </p>
          <p>
            Lot Authority starts for:{' '}
            {preview.authorityGained
              .map((party) => party.displayName)
              .join(', ') || 'Nobody'}
            .
          </p>
          {preview.access.map((change) => (
            <p key={change.personId}>
              {change.displayName}: Lot Authority {change.lotAuthority}; Member
              Access {change.memberAccess}.
            </p>
          ))}
          {preview.boardTerms.map((term) => (
            <p key={term.termId}>
              {term.displayName}:{' '}
              {term.action === 'substitute'
                ? `continue Board service using ${term.availableLots.find((option) => option.id === term.substituteLotId)?.address}`
                : `${term.action} Board Term; ${term.offices.length} office assignment(s) and ${term.boardGrantsEnding} Board Access grant(s) end`}
              .
            </p>
          ))}
          <p>
            {preview.resetMotionIds.length} open member-motion vote(s) will be
            reset. Up to {preview.reviewFlagCount} Review Flag(s) may be opened
            for affected records.
          </p>
          <p>
            Closed voting outcomes, conducted ballots, and frozen voting weights
            stay unchanged. Person Links and System Administration Access stay
            unchanged. Incoming owners receive no automatic Board Access.
          </p>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={confirm}
          >
            Confirm ownership transfer
          </button>
        </div>
      )}
    </section>
  );
}
