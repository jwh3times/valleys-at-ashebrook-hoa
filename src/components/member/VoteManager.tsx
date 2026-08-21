import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import ReportMarkdown from '../react/ReportMarkdown';
import { castBallot, castMotionVote } from '../../lib/voting';
import type {
  OpenElectionVotingItem,
  OpenMotionVotingItem,
  OpenVotingItem,
  VotingLot,
} from '../../lib/types';

export default function VoteManager({ items }: { items: OpenVotingItem[] }) {
  const [activeReview, setActiveReview] = useState<string | null>(null);
  return (
    <div className="vote-manager">
      {items.map((item) => (
        <section className="vote-item" key={`${item.kind}:${item.id}`}>
          <div className="vote-item__heading">
            <p className="eyebrow">
              {item.kind === 'election' ? 'Election ballot' : 'Member motion'}
            </p>
            <h2>{item.kind === 'election' ? item.title : item.meetingTitle}</h2>
            {item.kind === 'motion' && (
              <p className="vote-item__motion">{item.text}</p>
            )}
          </div>
          {item.lots.map((lot) => {
            const reviewKey = `${item.kind}:${item.id}:${lot.propertyId}`;
            const reviewBlocked =
              activeReview !== null && activeReview !== reviewKey;
            const onReviewingChange = (reviewing: boolean) =>
              setActiveReview(reviewing ? reviewKey : null);
            return lot.hasCast ? (
              <Receipt
                key={lot.propertyId}
                item={item}
                address={lot.address}
                recorded
              />
            ) : item.kind === 'election' ? (
              <ElectionBallot
                key={lot.propertyId}
                item={item}
                lot={lot}
                reviewBlocked={reviewBlocked}
                onReviewingChange={onReviewingChange}
              />
            ) : (
              <MotionBallot
                key={lot.propertyId}
                item={item}
                lot={lot}
                reviewBlocked={reviewBlocked}
                onReviewingChange={onReviewingChange}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

type Provenance = { castByPersonId: string | null; proxyId: string | null };

function defaultProvenance(lot: VotingLot): Provenance {
  if (lot.personOptions[0])
    return { castByPersonId: lot.personOptions[0].id, proxyId: null };
  return { castByPersonId: null, proxyId: lot.proxyOptions[0]?.id ?? null };
}

function provenanceSummary(lot: VotingLot, provenance: Provenance): string {
  if (provenance.castByPersonId !== null) {
    const person = lot.personOptions.find(
      (option) => option.id === provenance.castByPersonId,
    );
    return person
      ? `Voting as ${person.fullName}`
      : 'Voting authority unavailable';
  }
  const proxy = lot.proxyOptions.find(
    (option) => option.id === provenance.proxyId,
  );
  return proxy
    ? `Voting by proxy for ${proxy.grantingAddress} (${proxy.holderName})`
    : 'Voting authority unavailable';
}

function ProvenancePicker({
  lot,
  value,
  onChange,
  disabled,
}: {
  lot: VotingLot;
  value: Provenance;
  onChange: (next: Provenance) => void;
  disabled: boolean;
}) {
  const id = useId();
  const selectingPerson = value.castByPersonId !== null;
  return (
    <fieldset className="vote-provenance" disabled={disabled}>
      <legend>Voting authority</legend>
      {lot.personOptions.length > 0 && (
        <label>
          <input
            type="radio"
            name={`${id}-authority`}
            checked={selectingPerson}
            onChange={() =>
              onChange({
                castByPersonId: lot.personOptions[0].id,
                proxyId: null,
              })
            }
          />
          Vote as an owner or representative
        </label>
      )}
      {lot.personOptions.length > 1 && selectingPerson && (
        <label className="sr-only" htmlFor={`${id}-person`}>
          Person casting this ballot
        </label>
      )}
      {lot.personOptions.length > 1 && selectingPerson && (
        <select
          id={`${id}-person`}
          value={value.castByPersonId ?? ''}
          onChange={(event) =>
            onChange({ castByPersonId: event.target.value, proxyId: null })
          }
        >
          {lot.personOptions.map((person) => (
            <option key={person.id} value={person.id}>
              {person.fullName}
            </option>
          ))}
        </select>
      )}
      {lot.proxyOptions.map((proxy) => (
        <label key={proxy.id}>
          <input
            type="radio"
            name={`${id}-authority`}
            checked={value.proxyId === proxy.id}
            onChange={() =>
              onChange({ castByPersonId: null, proxyId: proxy.id })
            }
          />
          Vote by proxy for {proxy.grantingAddress}
        </label>
      ))}
    </fieldset>
  );
}

function ElectionBallot({
  item,
  lot,
  reviewBlocked,
  onReviewingChange,
}: {
  item: OpenElectionVotingItem;
  lot: VotingLot;
  reviewBlocked: boolean;
  onReviewingChange: (reviewing: boolean) => void;
}) {
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [provenance, setProvenance] = useState(() => defaultProvenance(lot));
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState(false);
  const candidateGroupId = useId();
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const backgroundBlocked = reviewing || reviewBlocked;
  const openReview = () => {
    setReviewing(true);
    onReviewingChange(true);
  };
  const closeReview = () => {
    setReviewing(false);
    onReviewingChange(false);
  };
  const toggleCandidate = (candidateId: string) => {
    setCandidateIds((selected) => {
      if (selected.includes(candidateId))
        return selected.filter((id) => id !== candidateId);
      return selected.length < item.seats
        ? [...selected, candidateId]
        : selected;
    });
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await castBallot({
        electionId: item.id,
        propertyId: lot.propertyId,
        candidateIds,
        ...provenance,
      });
      closeReview();
      setReceived(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to cast your ballot',
      );
      closeReview();
    } finally {
      setBusy(false);
    }
  };
  if (received) return <Receipt item={item} address={lot.address} />;
  return (
    <article className="vote-card">
      <div
        inert={backgroundBlocked}
        aria-hidden={backgroundBlocked ? 'true' : undefined}
      >
        <p className="vote-card__lot">
          Ballot for <strong>{lot.address}</strong>
        </p>
        <p className="vote-card__instruction">
          Choose up to {item.seats} candidate{item.seats === 1 ? '' : 's'}.
        </p>
        {error && (
          <p className="form-message form-message--error" role="alert">
            {error}
          </p>
        )}
        <fieldset
          className="vote-candidates"
          disabled={busy || backgroundBlocked}
        >
          <legend className="sr-only">Candidates</legend>
          {item.candidates.map((candidate) => {
            const inputId = `${candidateGroupId}-${candidate.id}`;
            const statementId = `${inputId}-statement`;
            return (
              <div className="vote-candidate" key={candidate.id}>
                <input
                  id={inputId}
                  type="checkbox"
                  aria-label={candidate.fullName}
                  aria-describedby={
                    candidate.statementMd ? statementId : undefined
                  }
                  checked={candidateIds.includes(candidate.id)}
                  disabled={
                    !candidateIds.includes(candidate.id) &&
                    candidateIds.length >= item.seats
                  }
                  onChange={() => toggleCandidate(candidate.id)}
                />
                <div className="vote-candidate__content">
                  <label htmlFor={inputId}>
                    <strong>{candidate.fullName}</strong>
                  </label>
                  {candidate.statementMd && (
                    <div id={statementId} className="vote-candidate__statement">
                      <ReportMarkdown text={candidate.statementMd} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </fieldset>
        <ProvenancePicker
          lot={lot}
          value={provenance}
          onChange={setProvenance}
          disabled={busy || backgroundBlocked}
        />
        <button
          ref={reviewButtonRef}
          className="btn vote-card__review"
          type="button"
          disabled={
            busy ||
            backgroundBlocked ||
            candidateIds.length === 0 ||
            (provenance.proxyId === null && provenance.castByPersonId === null)
          }
          onClick={openReview}
        >
          Review ballot
        </button>
      </div>
      {reviewing && (
        <FinalityDialog
          title="Review ballot"
          onCancel={closeReview}
          onConfirm={submit}
          busy={busy}
          confirmLabel="Cast final ballot"
          returnFocusRef={reviewButtonRef}
        >
          <p>Your ballot cannot be changed or recovered after it is cast.</p>
          <p>
            {candidateIds
              .map(
                (candidateId) =>
                  item.candidates.find(
                    (candidate) => candidate.id === candidateId,
                  )?.fullName,
              )
              .join(', ')}
          </p>
          <p>{provenanceSummary(lot, provenance)}</p>
        </FinalityDialog>
      )}
    </article>
  );
}

function MotionBallot({
  item,
  lot,
  reviewBlocked,
  onReviewingChange,
}: {
  item: OpenMotionVotingItem;
  lot: VotingLot;
  reviewBlocked: boolean;
  onReviewingChange: (reviewing: boolean) => void;
}) {
  const [choice, setChoice] = useState<'yes' | 'no' | 'abstain' | null>(null);
  const [provenance, setProvenance] = useState(() => defaultProvenance(lot));
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState(false);
  const id = useId();
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const backgroundBlocked = reviewing || reviewBlocked;
  const openReview = () => {
    setReviewing(true);
    onReviewingChange(true);
  };
  const closeReview = () => {
    setReviewing(false);
    onReviewingChange(false);
  };
  const submit = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await castMotionVote({
        motionId: item.id,
        propertyId: lot.propertyId,
        choice,
        ...provenance,
      });
      closeReview();
      setReceived(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to cast your vote',
      );
      closeReview();
    } finally {
      setBusy(false);
    }
  };
  if (received) return <Receipt item={item} address={lot.address} />;
  return (
    <article className="vote-card">
      <div
        inert={backgroundBlocked}
        aria-hidden={backgroundBlocked ? 'true' : undefined}
      >
        <p className="vote-card__lot">
          Vote for <strong>{lot.address}</strong>
        </p>
        <p className="vote-card__motion-text">{item.text}</p>
        {error && (
          <p className="form-message form-message--error" role="alert">
            {error}
          </p>
        )}
        <fieldset className="vote-choices" disabled={busy || backgroundBlocked}>
          <legend>Your vote</legend>
          {(['yes', 'no', 'abstain'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`${id}-choice`}
                checked={choice === value}
                onChange={() => setChoice(value)}
              />
              {value[0].toUpperCase() + value.slice(1)}
            </label>
          ))}
        </fieldset>
        <ProvenancePicker
          lot={lot}
          value={provenance}
          onChange={setProvenance}
          disabled={busy || backgroundBlocked}
        />
        <button
          ref={reviewButtonRef}
          className="btn vote-card__review"
          type="button"
          disabled={
            busy ||
            backgroundBlocked ||
            choice === null ||
            (provenance.proxyId === null && provenance.castByPersonId === null)
          }
          onClick={openReview}
        >
          Review vote
        </button>
      </div>
      {reviewing && (
        <FinalityDialog
          title="Review vote"
          onCancel={closeReview}
          onConfirm={submit}
          busy={busy}
          confirmLabel="Cast final vote"
          returnFocusRef={reviewButtonRef}
        >
          <p>You cannot change or recast this vote here after it is cast.</p>
          <p>
            The motion vote remains attributable, so the board can correct the
            recorded vote after voting closes.
          </p>
          <p>Choice: {choice && choice[0].toUpperCase() + choice.slice(1)}</p>
          <p>{provenanceSummary(lot, provenance)}</p>
        </FinalityDialog>
      )}
    </article>
  );
}

function FinalityDialog({
  title,
  children,
  onCancel,
  onConfirm,
  busy,
  confirmLabel,
  returnFocusRef,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  confirmLabel: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocusButton = returnFocusRef.current;
    firstButtonRef.current?.focus();
    return () => returnFocusButton?.focus();
  }, [returnFocusRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="vote-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="vote-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={handleKeyDown}
      >
        <h3>{title}</h3>
        {children}
        <div className="btn-row">
          <button
            ref={firstButtonRef}
            type="button"
            className="btn btn--outline"
            onClick={onCancel}
            disabled={busy}
          >
            Go back
          </button>
          <button
            type="button"
            className="btn"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Casting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Receipt({
  item,
  address,
  recorded = false,
}: {
  item: OpenVotingItem;
  address: string;
  recorded?: boolean;
}) {
  const title = item.kind === 'election' ? item.title : item.meetingTitle;
  const receiptKind = item.kind === 'election' ? 'Ballot' : 'Vote';
  return (
    <article className="vote-receipt" aria-live="polite">
      <span aria-hidden="true">✓</span>
      <div>
        <h3>
          {recorded
            ? `${receiptKind} recorded`
            : `${receiptKind} received for ${address}`}
        </h3>
        <p>{title}</p>
        {recorded && <p>{address}</p>}
      </div>
    </article>
  );
}
