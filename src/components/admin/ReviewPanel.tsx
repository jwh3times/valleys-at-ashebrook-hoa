import { useState } from 'react';
import {
  fetchReviewFlags,
  resolveReviewFlag,
  REVIEW_RESOLUTION_CODES,
} from '../../lib/roster-admin';
import type {
  ImpactedKind,
  ReviewFlagCategory,
  ReviewFlagRow,
  ReviewResolutionCode,
} from '../../lib/roster-admin';
import { useAdminResource } from './useAdminResource';

// A flag names something a transfer disturbed that the system deliberately
// did NOT rewrite. The label says what happened; the note says why a human
// has to look at it, because the category code alone reads as jargon.
const CATEGORY: Record<ReviewFlagCategory, { label: string; note: string }> = {
  intervening_action_backdated: {
    label: 'Intervening action (backdated change)',
    note: 'The change was recorded with an earlier effective day, and this record was created in between — it may have been taken by someone who, as now recorded, no longer held authority.',
  },
  authority_lost_pending_occasion: {
    label: 'Authority lost before an upcoming occasion',
    note: 'A proxy still stands for an occasion that has not happened yet, but its authority no longer holds. It will be refused if used.',
  },
  vote_reset_on_transfer: {
    label: 'Vote reset on transfer',
    note: "The lot's vote on an open motion was cleared so the new authority can cast it. Nothing else was changed.",
  },
  ballot_final_after_transfer: {
    label: 'Ballot final after transfer',
    note: 'A ballot in a conducted election was cast before the transfer and cannot be replaced — conducted ballots are final.',
  },
};

const IMPACTED_KIND: Record<ImpactedKind, string> = {
  proxy: 'Proxy',
  member_attendance: 'Member attendance record',
  member_vote: 'Member vote',
  motion: 'Motion',
  ballot: 'Ballot (turnout record)',
  board_term: 'Board term',
  access_grant: 'Access grant',
  audit_event: 'Audit event',
};

// The three codes a human may choose. `superseded` is deliberately absent —
// it belongs to the automatic void/correction path and the route refuses it
// with a 400, so offering it would build a button that cannot work.
const RESOLUTION_LABEL: Record<ReviewResolutionCode, string> = {
  remediated: 'Remediated — the record was corrected or the effect undone',
  confirmed_valid: 'Confirmed valid — the action stands as recorded',
  no_effect: 'No effect — nothing turned on this record',
};

/** Resolved rows show the code they carry, including the automatic one. */
const RESOLVED_LABEL: Record<ReviewResolutionCode | 'superseded', string> = {
  ...RESOLUTION_LABEL,
  superseded: 'Superseded by a correction',
};

function moment(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function SourceEvent({ flag }: { flag: ReviewFlagRow }) {
  const { family, eventKind, recordedAt, actorKind, actorAccountId } =
    flag.sourceEvent;
  const actor =
    actorKind === 'account' && actorAccountId
      ? `account ${actorAccountId}`
      : actorKind;
  return (
    <div className="admin-row-sub">
      Source event: {family} / {eventKind} · {moment(recordedAt)} · by {actor}
      {flag.sourceEvent.automaticCause
        ? ` · automatic (${flag.sourceEvent.automaticCause})`
        : ''}
    </div>
  );
}

function Impacted({ flag }: { flag: ReviewFlagRow }) {
  return (
    <div className="admin-row-sub">
      {flag.impacted
        ? `Impacted ${IMPACTED_KIND[flag.impacted.kind]}: ${flag.impacted.id}`
        : 'Impacted record: referenced record has since been deleted or replaced'}
    </div>
  );
}

function FlagCard({
  flag,
  busy,
  onResolve,
}: {
  flag: ReviewFlagRow;
  busy: boolean;
  onResolve: (id: string, code: ReviewResolutionCode) => void;
}) {
  const [code, setCode] = useState<ReviewResolutionCode | ''>('');
  const category = CATEGORY[flag.category];
  const selectId = `resolution-${flag.id}`;

  return (
    <div className="panel-card" style={{ marginBottom: '14px' }}>
      <div className="admin-row-main">
        <div className="admin-row-title">
          {category?.label ?? flag.category}
          <span className="admin-row-sub">
            {' '}
            · {flag.status === 'open' ? 'Open' : 'Resolved'}
          </span>
        </div>
        <div className="admin-row-sub">{category?.note}</div>
        <div className="admin-row-sub">
          Opened {moment(flag.openedAt)}
          {flag.resolvedAt !== null && ` · resolved ${moment(flag.resolvedAt)}`}
        </div>
        <SourceEvent flag={flag} />
        <Impacted flag={flag} />
        {flag.status === 'resolved' && flag.resolutionCode && (
          <div className="admin-row-sub">
            Resolution: {RESOLVED_LABEL[flag.resolutionCode]}
          </div>
        )}
      </div>

      {flag.status === 'open' && (
        <div className="btn-row" style={{ marginTop: '10px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={selectId}>How was this reviewed?</label>
            <select
              id={selectId}
              value={code}
              onChange={(e) =>
                setCode(e.target.value as ReviewResolutionCode | '')
              }
            >
              <option value="">— choose an outcome —</option>
              {REVIEW_RESOLUTION_CODES.map((c) => (
                <option key={c} value={c}>
                  {RESOLUTION_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn btn--small"
            disabled={busy || code === ''}
            aria-label={`Resolve ${category?.label ?? flag.category} flag: ${flag.id}`}
            onClick={() => code !== '' && onResolve(flag.id, code)}
          >
            Resolve
          </button>
        </div>
      )}
    </div>
  );
}

export default function ReviewPanel() {
  const { data, loading, reload, busy, msg, run } = useAdminResource<
    ReviewFlagRow[]
  >(fetchReviewFlags, []);

  async function handleResolve(id: string, code: ReviewResolutionCode) {
    await run(async () => {
      await resolveReviewFlag(id, code);
      await reload();
    }, 'Flag resolved.');
  }

  const openCount = data.filter((f) => f.status === 'open').length;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Review</h1>
      </div>
      <p className="admin-panel__intro">
        Transfers change who may act for a lot; they never rewrite what was
        already recorded. Anything a transfer disturbed is surfaced here
        instead. Resolving a flag records that a board member looked at it — it
        does not alter, invalidate, or hide the action the flag references.
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

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : data.length === 0 ? (
          <p className="muted panel-pad">No review flags.</p>
        ) : (
          <>
            <p className="admin-row-sub panel-pad">
              {openCount} open · {data.length - openCount} resolved
            </p>
            {data.map((flag) => (
              <FlagCard
                key={flag.id}
                flag={flag}
                busy={busy}
                onResolve={handleResolve}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
