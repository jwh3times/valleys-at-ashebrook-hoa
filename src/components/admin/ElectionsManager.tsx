import { useEffect, useState } from 'react';
import {
  fetchElections,
  saveElection,
  openElection,
  deleteElection,
  closeElection,
  voidElection,
  certifyElection,
  uncertifyElection,
  setTallies,
  setBallots,
  saveCandidate,
  deleteCandidate,
  fetchProperties,
  fetchLotPeople,
  fetchMeetingRosterPeople,
  fetchRosterPeople,
  fetchProxies,
} from '../../lib/admin';
import { fetchSiteSettings } from '../../lib/content';
import {
  electionAffordances,
  canWithdrawCandidate,
} from '../../lib/affordances';
import type {
  ElectionDetail,
  ElectionStatus,
  ElectionSource,
  ElectionInput,
  CandidateInput,
  CandidateSummary,
  Visibility,
  PropertyWithOwners,
  ProxyDetail,
} from '../../lib/types';
import type { LotPeople } from '../../lib/admin';
import { useAdminResource } from './useAdminResource';
import ProxyPicker, { proxiesForOccasion } from './ProxyPicker';

// Render order for the list: a board member managing an election is almost
// always looking at what's still open, so drafts lead, followed by closed
// (awaiting certification), then the settled states.
const STATUS_GROUPS: { status: ElectionStatus; label: string }[] = [
  { status: 'draft', label: 'Draft' },
  { status: 'open', label: 'Open' },
  { status: 'closed', label: 'Closed' },
  { status: 'certified', label: 'Certified' },
  { status: 'void', label: 'Void' },
];

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'public', label: 'Public (everyone)' },
  { value: 'homeowner', label: 'Homeowners only' },
  { value: 'board', label: 'Board only' },
];

const emptyElection = {
  title: '',
  seats: '1',
  electionDate: '',
  meetingId: '',
  visibility: 'board' as Visibility,
  source: 'recorded' as ElectionSource,
};

const emptyCandidate = { fullName: '', statementMd: '', personId: '' };

/**
 * The Persons offerable as a ballot's caster for one lot — current holders and
 * former ones alike, since a recorded paper election may predate a sale.
 */
function personsForLot(lotId: string, lotPeople: LotPeople[]) {
  return lotPeople.find((l) => l.lotId === lotId)?.persons ?? [];
}

/** Per-property ballot draft, keyed by propertyId. */
interface BallotFormRow {
  selected: boolean;
  weight: string;
  /** Empty string = no proxy. Picking a proxy clears castByPersonId. */
  proxyId: string;
  castByPersonId: string;
}

/** Per-candidate winner draft for certification, keyed by candidateId.
 * #218 shape: a party-roster Person, a qualifying Lot, term days, and an
 * optional bylaws office — certification writes board_service_terms now,
 * never the retired legacy board roster. */
interface WinnerFormRow {
  selected: boolean;
  personId: string;
  qualifyingLotId: string;
  startDay: string;
  scheduledEndDay: string;
  office: string;
}

const emptyWinnerRow: WinnerFormRow = {
  selected: false,
  personId: '',
  qualifyingLotId: '',
  startDay: '',
  scheduledEndDay: '',
  office: '',
};

export default function ElectionsManager() {
  const {
    data: elections,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<ElectionDetail[]>(fetchElections, []);
  const [votingAvailable, setVotingAvailable] = useState(false);
  const [view, setView] = useState<'active' | 'history'>('active');

  useEffect(() => {
    fetchSiteSettings()
      .then((site) =>
        setVotingAvailable(site.officialMode && site.liveVotingEnabled),
      )
      .catch(() => setVotingAvailable(false));
  }, []);

  // The property roster backs the ballot picker — loaded once alongside the
  // elections, independent of useAdminResource since it isn't the panel's
  // primary save/delete target. Only active properties are eligible to cast
  // a ballot, matching ADR 0015's treatment of member-meeting attendance.
  const [properties, setProperties] = useState<PropertyWithOwners[]>([]);
  // Who may act for each lot, for the ballot caster picker — the roster's Lot
  // Authority since #248 part 2, former holders included so a paper election
  // from before a sale stays recordable.
  const [lotPeople, setLotPeople] = useState<LotPeople[]>([]);
  useEffect(() => {
    fetchProperties()
      .then(setProperties)
      .catch((err: unknown) => {
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the property roster.';
        setMsg('Error: ' + message);
      });
    fetchLotPeople()
      .then(setLotPeople)
      .catch((err: unknown) => {
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load who may act for each lot.';
        setMsg('Error: ' + message);
      });
  }, [setMsg]);
  const activeProperties = properties.filter((p) => p.status === 'active');

  // The meeting-record people list backs the candidate's optional "link to
  // board member" picker (legacy board_people ids the meeting record still
  // references); the PARTY-ROSTER people list backs the certification form's
  // person picker — empty until the flip's backfill populates the roster.
  const [boardPeople, setBoardPeople] = useState<
    { id: string; fullName: string }[]
  >([]);
  const [rosterPeople, setRosterPeople] = useState<
    { partyId: string; displayName: string }[]
  >([]);
  useEffect(() => {
    fetchMeetingRosterPeople()
      .then(setBoardPeople)
      .catch((err: unknown) => {
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the board roster.';
        setMsg('Error: ' + message);
      });
    fetchRosterPeople()
      .then(setRosterPeople)
      .catch((err: unknown) => {
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the party roster.';
        setMsg('Error: ' + message);
      });
  }, [setMsg]);

  // Recorded proxies back the ballot picker below — loaded once alongside
  // properties/board people, independent of useAdminResource.
  const [proxyList, setProxyList] = useState<ProxyDetail[]>([]);
  useEffect(() => {
    fetchProxies()
      .then(setProxyList)
      .catch(() => {});
  }, []);

  const [electionForm, setElectionForm] = useState(emptyElection);
  const [editingElectionId, setEditingElectionId] = useState<string | null>(
    null,
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [candidateForm, setCandidateForm] = useState(emptyCandidate);
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(
    null,
  );
  const [tallyForm, setTallyForm] = useState<Record<string, string>>({});
  const [ballotForm, setBallotForm] = useState<Record<string, BallotFormRow>>(
    {},
  );
  const [winnerForm, setWinnerForm] = useState<Record<string, WinnerFormRow>>(
    {},
  );

  // Seed the candidate/tally/ballot/winner drafts from the election's own
  // data the moment its panel opens — not re-synced on every subsequent
  // reload, the same choice MeetingsManager makes for its attendance forms,
  // so a half-typed tally isn't clobbered by the panel's own save-then-reload.
  useEffect(() => {
    if (!expandedId) return;
    const found = elections.find((e) => e.id === expandedId);
    if (!found) return;
    setTallyForm(
      Object.fromEntries(
        found.candidates.map((c) => [
          c.id,
          c.votes === null ? '' : String(c.votes),
        ]),
      ),
    );
    setBallotForm(
      Object.fromEntries(
        (found.ballots ?? []).map((b) => [
          b.propertyId,
          {
            selected: true,
            weight: String(b.weight),
            proxyId: b.proxyId ?? '',
            castByPersonId: b.castByPersonId ?? '',
          },
        ]),
      ),
    );
    setWinnerForm({});
    // Re-derive only when the expanded election changes.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [expandedId]);

  function resetElection() {
    setEditingElectionId(null);
    setElectionForm(emptyElection);
  }
  function resetCandidate() {
    setEditingCandidateId(null);
    setCandidateForm(emptyCandidate);
  }
  function toTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEdit(e: ElectionDetail) {
    setEditingElectionId(e.id);
    setElectionForm({
      title: e.title,
      seats: String(e.seats),
      electionDate: e.electionDate,
      meetingId: e.meetingId ?? '',
      visibility: e.visibility,
      source: e.source,
    });
    setMsg('');
    toTop();
  }

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
    resetCandidate();
    setMsg('');
  }

  function winnerRow(candidateId: string): WinnerFormRow {
    return winnerForm[candidateId] ?? emptyWinnerRow;
  }

  async function submitElection(e: React.FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        // Distinguish blank from zero: `Number(x) || 1` would silently turn a
        // typed 0 into 1, which means the server never sees the bad value and
        // never gets the chance to explain why it's bad — the same class of
        // bug as an earlier PR's `Number(form) || 1` silently substituting a
        // vote weight nobody typed. A blank field sends `undefined` (dropped
        // by JSON.stringify, so create's own "seats is required" guard fires
        // and edit leaves the value unchanged); a typed 0 sends the real 0 so
        // the server's "seats must be at least 1" 400 reaches the board.
        const trimmedSeats = electionForm.seats.trim();
        const seats = trimmedSeats === '' ? undefined : Number(trimmedSeats);
        const data: ElectionInput = {
          title: electionForm.title,
          seats,
          electionDate: electionForm.electionDate,
          meetingId: electionForm.meetingId || null,
          visibility: electionForm.visibility,
          source: electionForm.source,
        };
        await saveElection(data, editingElectionId ?? undefined);
        resetElection();
        await reload();
      },
      editingElectionId ? 'Election updated.' : 'Election added.',
    );
  }

  async function handleOpen(e: ElectionDetail) {
    await run(async () => {
      await openElection(e.id);
      await reload();
    }, 'Election opened.');
  }

  async function handleClose(e: ElectionDetail) {
    await run(async () => {
      await closeElection(e.id);
      await reload();
    }, 'Election closed.');
  }

  async function handleVoid(e: ElectionDetail) {
    if (!confirm(`Void "${e.title}"? This cannot be undone.`)) return;
    await run(async () => {
      await voidElection(e.id);
      await reload();
    }, 'Election voided.');
  }

  async function handleUncertify(e: ElectionDetail) {
    if (
      !confirm(
        `Uncertify "${e.title}"? This voids the terms of service it created.`,
      )
    )
      return;
    await run(async () => {
      await uncertifyElection(e.id);
      await reload();
    }, 'Election uncertified.');
  }

  async function handleDelete(e: ElectionDetail) {
    if (!confirm(`Delete "${e.title}"? This cannot be undone.`)) return;
    await run(async () => {
      await deleteElection(e.id);
      if (expandedId === e.id) setExpandedId(null);
      await reload();
    }, 'Election deleted.');
  }

  async function submitCandidate(evt: React.FormEvent, electionId: string) {
    evt.preventDefault();
    await run(
      async () => {
        const data: CandidateInput = {
          fullName: candidateForm.fullName,
          statementMd: candidateForm.statementMd || null,
          personId: candidateForm.personId || null,
        };
        await saveCandidate(electionId, data, editingCandidateId ?? undefined);
        resetCandidate();
        await reload();
      },
      editingCandidateId ? 'Candidate updated.' : 'Candidate added.',
    );
  }

  function startEditCandidate(c: CandidateSummary) {
    setEditingCandidateId(c.id);
    setCandidateForm({
      fullName: c.fullName,
      statementMd: c.statementMd ?? '',
      personId: c.personId ?? '',
    });
    setMsg('');
  }

  async function toggleWithdrawn(electionId: string, c: CandidateSummary) {
    await run(
      async () => {
        await saveCandidate(electionId, { withdrawn: !c.withdrawn }, c.id);
        await reload();
      },
      c.withdrawn ? 'Candidate reinstated.' : 'Candidate withdrawn.',
    );
  }

  async function removeCandidate(c: CandidateSummary) {
    if (!confirm(`Remove candidate "${c.fullName}"? This cannot be undone.`))
      return;
    await run(async () => {
      await deleteCandidate(c.id);
      if (editingCandidateId === c.id) resetCandidate();
      await reload();
    }, 'Candidate removed.');
  }

  async function submitTallies(evt: React.FormEvent, e: ElectionDetail) {
    evt.preventDefault();
    await run(async () => {
      // Blank means omit, not zero: `votes` is nullable so NULL ("not
      // recorded") stays distinguishable from a recorded 0. A candidate left
      // blank is dropped from `entries` entirely — the server restores NULL
      // for any candidate it doesn't see — rather than defaulting to 0 the
      // way `Number(x) || 0` would, which would silently record a tally
      // nobody typed. A non-numeric entry (e.g. "1o") is still sent through
      // as `Number(x.raw)` so the server's own validation rejects it with a
      // readable 400 instead of the client swallowing it into a false zero.
      const entries = e.candidates
        .map((c) => ({
          candidateId: c.id,
          raw: (tallyForm[c.id] ?? '').trim(),
        }))
        .filter((x) => x.raw !== '')
        .map((x) => ({ candidateId: x.candidateId, votes: Number(x.raw) }));
      await setTallies(e.id, entries);
      await reload();
    }, 'Tallies saved.');
  }

  async function submitBallots(evt: React.FormEvent, e: ElectionDetail) {
    evt.preventDefault();
    await run(async () => {
      // Only properties whose checkbox is checked go in — unlike attendance,
      // a ballot row means "this lot returned a ballot"; there is no
      // "did not vote" row to keep, so an unchecked property is simply
      // omitted, the same as an untouched motion vote.
      const entries = activeProperties
        .filter((p) => ballotForm[p.id]?.selected)
        .map((p) => {
          const row = ballotForm[p.id];
          const trimmedWeight = row.weight.trim();
          return {
            propertyId: p.id,
            weight: trimmedWeight === '' ? undefined : Number(trimmedWeight),
            proxyId: row.proxyId || null,
            castByPersonId: row.castByPersonId || null,
          };
        });
      await setBallots(e.id, entries);
      await reload();
    }, 'Ballots saved.');
  }

  async function submitCertify(evt: React.FormEvent, e: ElectionDetail) {
    evt.preventDefault();
    // Per-winner term fields — collected before certifyElection is ever
    // called, so a board member who forgot to select anyone gets refused
    // client-side rather than a wasted round trip and a 400.
    const winners = e.candidates
      .filter((c) => winnerForm[c.id]?.selected)
      .map((c) => {
        const row = winnerRow(c.id);
        return {
          candidateId: c.id,
          personId: row.personId || null,
          qualifyingLotId: row.qualifyingLotId,
          startDay: row.startDay,
          scheduledEndDay: row.scheduledEndDay,
          office: row.office || null,
        };
      });
    if (winners.length === 0) {
      setMsg('Error: Select at least one winner before certifying.');
      return;
    }
    await run(async () => {
      await certifyElection(e.id, winners);
      setWinnerForm({});
      await reload();
    }, 'Election certified.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Elections</h1>
      </div>
      <p className="admin-panel__intro">
        Record paper elections or conduct homeowner voting through the site. An
        election stays active while it is a draft or open; closed, certified,
        and void elections remain in History as a durable association record.
        Certifying seats the winners on the board.
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

      <form
        className="panel-card"
        onSubmit={submitElection}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">
          {editingElectionId ? 'Edit Election' : 'Add Election'}
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="election-title">Title</label>
            <input
              id="election-title"
              type="text"
              value={electionForm.title}
              onChange={(e) =>
                setElectionForm({ ...electionForm, title: e.target.value })
              }
              placeholder="2026 Board Election"
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="election-seats">Seats</label>
            <input
              id="election-seats"
              type="number"
              value={electionForm.seats}
              onChange={(e) =>
                setElectionForm({ ...electionForm, seats: e.target.value })
              }
            />
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="election-date">Election date</label>
            <input
              id="election-date"
              type="date"
              value={electionForm.electionDate}
              onChange={(e) =>
                setElectionForm({
                  ...electionForm,
                  electionDate: e.target.value,
                })
              }
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="election-meeting">Meeting ID (optional)</label>
            <input
              id="election-meeting"
              type="text"
              value={electionForm.meetingId}
              onChange={(e) =>
                setElectionForm({
                  ...electionForm,
                  meetingId: e.target.value,
                })
              }
              placeholder="From the Meetings tab"
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: '16px' }}>
          <label htmlFor="election-visibility">Visibility</label>
          <select
            id="election-visibility"
            value={electionForm.visibility}
            onChange={(e) =>
              setElectionForm({
                ...electionForm,
                visibility: e.target.value as Visibility,
              })
            }
          >
            {VISIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {!editingElectionId && (
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="election-source">Election type</label>
            <select
              id="election-source"
              value={electionForm.source}
              onChange={(event) =>
                setElectionForm({
                  ...electionForm,
                  source: event.target.value as ElectionSource,
                })
              }
            >
              <option value="recorded">Recorded</option>
              <option value="conducted">Conducted</option>
            </select>
            <p className="muted" style={{ marginTop: '6px' }}>
              Recorded elections preserve paper results. Conducted elections
              accept homeowner ballots through this site once opened.
            </p>
          </div>
        )}
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy
              ? 'Saving…'
              : editingElectionId
                ? 'Save Election'
                : 'Add Election'}
          </button>
          {editingElectionId && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetElection}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div
        className="btn-row"
        aria-label="Election view"
        style={{ marginBottom: '18px' }}
      >
        <button
          type="button"
          className={
            view === 'active' ? 'btn btn--small' : 'btn btn--outline btn--small'
          }
          aria-pressed={view === 'active'}
          onClick={() => setView('active')}
        >
          Active
        </button>
        <button
          type="button"
          className={
            view === 'history'
              ? 'btn btn--small'
              : 'btn btn--outline btn--small'
          }
          aria-pressed={view === 'history'}
          onClick={() => setView('history')}
        >
          History
        </button>
      </div>

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : elections.length === 0 ? (
          <p className="muted panel-pad">No elections yet.</p>
        ) : (
          STATUS_GROUPS.filter(({ status }) =>
            view === 'active'
              ? status === 'draft' || status === 'open'
              : status === 'closed' ||
                status === 'certified' ||
                status === 'void',
          ).map(({ status, label }) => {
            const group = elections.filter((e) => e.status === status);
            if (group.length === 0) return null;
            return (
              <div key={status} style={{ marginBottom: '22px' }}>
                <h2 style={{ marginBottom: '10px' }}>{label}</h2>
                {group.map((e) => {
                  const can = electionAffordances(e);
                  return (
                    <div
                      key={e.id}
                      className="panel-card"
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="list-row">
                        <div className="admin-row-main">
                          <div className="admin-row-title">
                            {e.title}{' '}
                            <span className="pinned-badge">
                              {e.source === 'conducted'
                                ? 'Conducted'
                                : 'Recorded'}
                            </span>
                            {e.source === 'conducted' &&
                              e.status === 'open' &&
                              !votingAvailable && (
                                <span className="pinned-badge">
                                  {' '}
                                  Paused globally
                                </span>
                              )}
                          </div>
                          <div className="admin-row-sub">
                            {e.electionDate} · {e.seats}{' '}
                            {e.seats === 1 ? 'seat' : 'seats'} ·{' '}
                            {e.candidates.length}{' '}
                            {e.candidates.length === 1
                              ? 'candidate'
                              : 'candidates'}{' '}
                            · {e.turnout.ballotsCast} of{' '}
                            {e.turnout.eligibleCount} ballots cast
                            {e.source === 'conducted' && (
                              <>
                                {' '}
                                · {e.turnout.weightCast} of{' '}
                                {e.turnout.eligibleWeight} weight cast
                              </>
                            )}
                          </div>
                        </div>
                        <div className="row-actions">
                          {can.canEditElection && (
                            <button
                              className="row-link"
                              aria-label={`Edit ${e.title}`}
                              onClick={() => startEdit(e)}
                            >
                              Edit
                            </button>
                          )}
                          <button
                            className="row-link"
                            aria-label={
                              expandedId === e.id
                                ? `Hide details for ${e.title}`
                                : `Details for ${e.title}`
                            }
                            onClick={() => toggleExpand(e.id)}
                          >
                            {expandedId === e.id ? 'Hide details' : 'Details'}
                          </button>
                          {e.status === 'draft' && (
                            <>
                              {e.source === 'conducted' ? (
                                <button
                                  className="row-link"
                                  aria-label={`Open ${e.title}`}
                                  onClick={() => handleOpen(e)}
                                >
                                  Open
                                </button>
                              ) : (
                                <button
                                  className="row-link"
                                  aria-label={`Close ${e.title}`}
                                  onClick={() => handleClose(e)}
                                >
                                  Close
                                </button>
                              )}
                              <button
                                className="row-link row-link--danger"
                                aria-label={`Delete ${e.title}`}
                                onClick={() => handleDelete(e)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                          {e.status === 'open' && (
                            <button
                              className="row-link"
                              aria-label={`Close ${e.title}`}
                              onClick={() => handleClose(e)}
                            >
                              Close
                            </button>
                          )}
                          {can.canVoid && (
                            <button
                              className="row-link row-link--danger"
                              aria-label={`Void ${e.title}`}
                              onClick={() => handleVoid(e)}
                            >
                              Void
                            </button>
                          )}
                          {can.canUncertify && (
                            <button
                              className="row-link"
                              aria-label={`Uncertify ${e.title}`}
                              onClick={() => handleUncertify(e)}
                            >
                              Uncertify
                            </button>
                          )}
                        </div>
                      </div>

                      {expandedId === e.id && (
                        <div
                          style={{ paddingLeft: '18px', paddingTop: '10px' }}
                        >
                          <div
                            className="panel-card"
                            style={{ marginBottom: '14px' }}
                          >
                            <div className="panel-editor__title">
                              Candidates
                            </div>
                            {e.candidates.length === 0 ? (
                              <p className="muted">
                                No candidates recorded yet.
                              </p>
                            ) : (
                              e.candidates.map((c) => (
                                <div key={c.id} className="list-row">
                                  <div className="admin-row-main">
                                    <div className="admin-row-title">
                                      {c.fullName}
                                      {c.won && (
                                        <span className="pinned-badge">
                                          {' '}
                                          Won
                                        </span>
                                      )}
                                      {c.withdrawn && (
                                        <span className="pinned-badge">
                                          {' '}
                                          Withdrawn
                                        </span>
                                      )}
                                    </div>
                                    {!(
                                      e.source === 'conducted' &&
                                      e.status === 'open'
                                    ) && (
                                      <div className="admin-row-sub">
                                        {c.votes === null
                                          ? 'No tally recorded'
                                          : `${c.votes} votes`}
                                      </div>
                                    )}
                                  </div>
                                  {(can.canEditCandidate ||
                                    canWithdrawCandidate(e, c)) && (
                                    <div className="row-actions">
                                      {can.canEditCandidate && (
                                        <button
                                          className="row-link"
                                          aria-label={`Edit candidate ${c.fullName}`}
                                          onClick={() => startEditCandidate(c)}
                                        >
                                          Edit
                                        </button>
                                      )}
                                      {canWithdrawCandidate(e, c) && (
                                        <button
                                          className="row-link"
                                          onClick={() =>
                                            toggleWithdrawn(e.id, c)
                                          }
                                        >
                                          {c.withdrawn
                                            ? 'Reinstate'
                                            : 'Withdraw'}
                                        </button>
                                      )}
                                      {can.canRemoveCandidate && (
                                        <button
                                          className="row-link row-link--danger"
                                          aria-label={`Remove candidate ${c.fullName}`}
                                          onClick={() => removeCandidate(c)}
                                        >
                                          Remove
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}

                            {(editingCandidateId
                              ? can.canEditCandidate
                              : can.canAddCandidate) && (
                              <form
                                onSubmit={(evt) => submitCandidate(evt, e.id)}
                                style={{ marginTop: '14px' }}
                              >
                                <div className="panel-editor__title">
                                  {editingCandidateId
                                    ? 'Edit candidate'
                                    : 'Add candidate'}
                                </div>
                                <div
                                  className="field-grid"
                                  style={{ marginBottom: '16px' }}
                                >
                                  <div className="field" style={{ margin: 0 }}>
                                    <label htmlFor={`candidate-name-${e.id}`}>
                                      Full name
                                    </label>
                                    <input
                                      id={`candidate-name-${e.id}`}
                                      type="text"
                                      value={candidateForm.fullName}
                                      onChange={(evt) =>
                                        setCandidateForm({
                                          ...candidateForm,
                                          fullName: evt.target.value,
                                        })
                                      }
                                      required
                                    />
                                  </div>
                                  <div className="field" style={{ margin: 0 }}>
                                    <label htmlFor={`candidate-person-${e.id}`}>
                                      Link to a resident (optional)
                                    </label>
                                    <select
                                      id={`candidate-person-${e.id}`}
                                      value={candidateForm.personId}
                                      onChange={(evt) =>
                                        setCandidateForm({
                                          ...candidateForm,
                                          personId: evt.target.value,
                                        })
                                      }
                                    >
                                      <option value="">— none —</option>
                                      {boardPeople.map((p) => (
                                        <option key={p.id} value={p.id}>
                                          {p.fullName}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                <div
                                  className="field"
                                  style={{ marginBottom: '16px' }}
                                >
                                  <label
                                    htmlFor={`candidate-statement-${e.id}`}
                                  >
                                    Statement (optional)
                                  </label>
                                  <textarea
                                    id={`candidate-statement-${e.id}`}
                                    value={candidateForm.statementMd}
                                    onChange={(evt) =>
                                      setCandidateForm({
                                        ...candidateForm,
                                        statementMd: evt.target.value,
                                      })
                                    }
                                  />
                                </div>
                                <div className="btn-row">
                                  <button
                                    className="btn btn--small"
                                    type="submit"
                                    disabled={busy}
                                  >
                                    {busy
                                      ? 'Saving…'
                                      : editingCandidateId
                                        ? 'Save candidate'
                                        : 'Add candidate'}
                                  </button>
                                  {editingCandidateId && (
                                    <button
                                      type="button"
                                      className="btn btn--outline btn--small"
                                      onClick={resetCandidate}
                                    >
                                      Cancel
                                    </button>
                                  )}
                                </div>
                              </form>
                            )}
                          </div>

                          {e.source === 'conducted' && (
                            <>
                              <div
                                className="panel-card"
                                style={{ marginBottom: '14px' }}
                              >
                                <div className="panel-editor__title">
                                  Eligibility register
                                </div>
                                <p className="muted">
                                  {e.turnout.eligibleWeight} eligible weight ·{' '}
                                  {e.turnout.eligibleCount}{' '}
                                  {e.turnout.eligibleCount === 1
                                    ? 'lot'
                                    : 'lots'}{' '}
                                  ·{' '}
                                  {e.turnout.eligibilityFrozen
                                    ? 'Frozen at open'
                                    : 'Current roster'}
                                </p>
                                {(e.eligibleProperties?.length ?? 0) === 0 ? (
                                  <p className="muted">
                                    No eligible properties recorded.
                                  </p>
                                ) : (
                                  e.eligibleProperties!.map((property) => (
                                    <div
                                      key={property.propertyId}
                                      className="list-row"
                                    >
                                      <div className="admin-row-main">
                                        <div className="admin-row-title">
                                          {property.address}
                                        </div>
                                      </div>
                                      <div className="admin-row-sub">
                                        Weight {property.weight}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>

                              <div
                                className="panel-card"
                                style={{ marginBottom: '14px' }}
                              >
                                <div className="panel-editor__title">
                                  Turnout register
                                </div>
                                {(e.ballots?.length ?? 0) === 0 ? (
                                  <p className="muted">
                                    No ballots received yet.
                                  </p>
                                ) : (
                                  e.ballots!.map((ballot) => (
                                    <div
                                      key={ballot.propertyId}
                                      className="list-row"
                                    >
                                      <div className="admin-row-main">
                                        <div className="admin-row-title">
                                          {ballot.address}
                                        </div>
                                        {ballot.viaProxy && (
                                          <div className="admin-row-sub">
                                            Via proxy
                                          </div>
                                        )}
                                      </div>
                                      <div className="admin-row-sub">
                                        Weight {ballot.weight}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            </>
                          )}

                          {can.canEditTallies && e.candidates.length > 0 && (
                            <form
                              className="panel-card"
                              onSubmit={(evt) => submitTallies(evt, e)}
                              style={{ marginBottom: '14px' }}
                            >
                              <div className="panel-editor__title">Tallies</div>
                              {e.candidates.map((c) => (
                                <div
                                  key={c.id}
                                  className="field"
                                  style={{ margin: '0 0 10px' }}
                                >
                                  <label htmlFor={`tally-${e.id}-${c.id}`}>
                                    Tally — {c.fullName}
                                  </label>
                                  <input
                                    id={`tally-${e.id}-${c.id}`}
                                    type="number"
                                    value={tallyForm[c.id] ?? ''}
                                    onChange={(evt) =>
                                      setTallyForm((prev) => ({
                                        ...prev,
                                        [c.id]: evt.target.value,
                                      }))
                                    }
                                  />
                                </div>
                              ))}
                              <div className="btn-row">
                                <button
                                  className="btn btn--small"
                                  type="submit"
                                  disabled={busy}
                                >
                                  {busy ? 'Saving…' : 'Save tallies'}
                                </button>
                              </div>
                            </form>
                          )}

                          {can.canEditBallots && (
                            <form
                              className="panel-card"
                              onSubmit={(evt) => submitBallots(evt, e)}
                              style={{ marginBottom: '14px' }}
                            >
                              <div className="panel-editor__title">Ballots</div>
                              {activeProperties.length === 0 ? (
                                <p className="muted">
                                  No properties yet — add homes on The Roster
                                  tab.
                                </p>
                              ) : (
                                activeProperties.map((p) => {
                                  const row = ballotForm[p.id];
                                  return (
                                    <div
                                      key={p.id}
                                      style={{ marginBottom: '10px' }}
                                    >
                                      <label
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '8px',
                                        }}
                                        htmlFor={`ballot-${e.id}-${p.id}`}
                                      >
                                        <input
                                          id={`ballot-${e.id}-${p.id}`}
                                          type="checkbox"
                                          checked={!!row?.selected}
                                          onChange={(evt) =>
                                            setBallotForm((prev) => ({
                                              ...prev,
                                              [p.id]: {
                                                selected: evt.target.checked,
                                                weight:
                                                  prev[p.id]?.weight ?? '',
                                                proxyId:
                                                  prev[p.id]?.proxyId ?? '',
                                                castByPersonId:
                                                  prev[p.id]?.castByPersonId ??
                                                  '',
                                              },
                                            }))
                                          }
                                        />
                                        Ballot returned — {p.address}
                                        {p.unit ? ` ${p.unit}` : ''}
                                      </label>
                                      {row?.selected && (
                                        <div
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            flexWrap: 'wrap',
                                            gap: '8px',
                                            paddingLeft: '26px',
                                            marginTop: '4px',
                                          }}
                                        >
                                          <label
                                            htmlFor={`ballot-weight-${e.id}-${p.id}`}
                                          >
                                            Weight override (optional) —{' '}
                                            {p.address}
                                          </label>
                                          <input
                                            id={`ballot-weight-${e.id}-${p.id}`}
                                            type="number"
                                            value={row?.weight ?? ''}
                                            onChange={(evt) =>
                                              setBallotForm((prev) => ({
                                                ...prev,
                                                [p.id]: {
                                                  selected:
                                                    prev[p.id]?.selected ??
                                                    true,
                                                  weight: evt.target.value,
                                                  proxyId:
                                                    prev[p.id]?.proxyId ?? '',
                                                  castByPersonId:
                                                    prev[p.id]?.castByPersonId ??
                                                    '',
                                                },
                                              }))
                                            }
                                            placeholder={String(p.voteWeight)}
                                          />
                                          {personsForLot(p.id, lotPeople).length > 0 && (
                                            <>
                                              <label
                                                htmlFor={`ballot-cast-by-${e.id}-${p.id}`}
                                              >
                                                Cast by — {p.address}
                                              </label>
                                              <select
                                                id={`ballot-cast-by-${e.id}-${p.id}`}
                                                value={row?.castByPersonId ?? ''}
                                                disabled={
                                                  busy || !!row?.proxyId
                                                }
                                                onChange={(evt) =>
                                                  setBallotForm((prev) => ({
                                                    ...prev,
                                                    [p.id]: {
                                                      selected:
                                                        prev[p.id]?.selected ??
                                                        true,
                                                      weight:
                                                        prev[p.id]?.weight ??
                                                        '',
                                                      proxyId:
                                                        prev[p.id]?.proxyId ??
                                                        '',
                                                      castByPersonId:
                                                        evt.target.value,
                                                    },
                                                  }))
                                                }
                                              >
                                                <option value="">
                                                  — none —
                                                </option>
                                                {personsForLot(p.id, lotPeople).map((o) => (
                                                  <option
                                                    key={o.id}
                                                    value={o.id}
                                                  >
                                                    {o.fullName}
                                                  </option>
                                                ))}
                                              </select>
                                            </>
                                          )}
                                          <ProxyPicker
                                            id={`ballot-proxy-${e.id}-${p.id}`}
                                            address={p.address}
                                            lotProxies={proxiesForOccasion(
                                              proxyList,
                                              p.id,
                                              {
                                                kind: 'election',
                                                electionId: e.id,
                                                meetingId: e.meetingId,
                                              },
                                            )}
                                            value={row?.proxyId ?? ''}
                                            bare
                                            onChange={(proxyId) =>
                                              setBallotForm((prev) => ({
                                                ...prev,
                                                [p.id]: {
                                                  selected:
                                                    prev[p.id]?.selected ??
                                                    true,
                                                  weight:
                                                    prev[p.id]?.weight ?? '',
                                                  proxyId,
                                                  // Mutual exclusion, mirrored
                                                  // from the server: picking
                                                  // a proxy clears the
                                                  // cast-by owner.
                                                  castByPersonId: proxyId
                                                    ? ''
                                                    : (prev[p.id]
                                                        ?.castByPersonId ?? ''),
                                                },
                                              }))
                                            }
                                          />
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                              )}
                              <div className="btn-row">
                                <button
                                  className="btn btn--small"
                                  type="submit"
                                  disabled={
                                    busy || activeProperties.length === 0
                                  }
                                >
                                  {busy ? 'Saving…' : 'Save ballots'}
                                </button>
                              </div>
                            </form>
                          )}

                          {can.canCertify && (
                            <form
                              className="panel-card"
                              onSubmit={(evt) => submitCertify(evt, e)}
                            >
                              <div className="panel-editor__title">
                                Certify this election
                              </div>
                              {e.candidates.filter((c) => !c.withdrawn)
                                .length === 0 ? (
                                <p className="muted">
                                  No eligible candidates to certify.
                                </p>
                              ) : (
                                e.candidates
                                  .filter((c) => !c.withdrawn)
                                  .map((c) => {
                                    const row = winnerRow(c.id);
                                    return (
                                      <div
                                        key={c.id}
                                        style={{ marginBottom: '14px' }}
                                      >
                                        <label
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '8px',
                                          }}
                                          htmlFor={`winner-${e.id}-${c.id}`}
                                        >
                                          <input
                                            id={`winner-${e.id}-${c.id}`}
                                            type="checkbox"
                                            checked={row.selected}
                                            onChange={(evt) =>
                                              setWinnerForm((prev) => ({
                                                ...prev,
                                                [c.id]: {
                                                  ...winnerRow(c.id),
                                                  selected: evt.target.checked,
                                                },
                                              }))
                                            }
                                          />
                                          Winner — {c.fullName}
                                        </label>
                                        {row.selected && (
                                          <div
                                            className="field-grid"
                                            style={{
                                              marginTop: '8px',
                                              paddingLeft: '26px',
                                            }}
                                          >
                                            <div
                                              className="field"
                                              style={{ margin: 0 }}
                                            >
                                              <label
                                                htmlFor={`winner-person-${e.id}-${c.id}`}
                                              >
                                                Person — {c.fullName}
                                              </label>
                                              <select
                                                id={`winner-person-${e.id}-${c.id}`}
                                                value={row.personId}
                                                onChange={(evt) =>
                                                  setWinnerForm((prev) => ({
                                                    ...prev,
                                                    [c.id]: {
                                                      ...winnerRow(c.id),
                                                      personId:
                                                        evt.target.value,
                                                    },
                                                  }))
                                                }
                                              >
                                                <option value="">
                                                  {'\u2014'} select the person{' '}
                                                  {'\u2014'}
                                                </option>
                                                {rosterPeople.map((p) => (
                                                  <option
                                                    key={p.partyId}
                                                    value={p.partyId}
                                                  >
                                                    {p.displayName}
                                                  </option>
                                                ))}
                                              </select>
                                            </div>
                                            <div
                                              className="field"
                                              style={{ margin: 0 }}
                                            >
                                              <label
                                                htmlFor={`winner-lot-${e.id}-${c.id}`}
                                              >
                                                Qualifying lot — {c.fullName}
                                              </label>
                                              <select
                                                id={`winner-lot-${e.id}-${c.id}`}
                                                value={row.qualifyingLotId}
                                                onChange={(evt) =>
                                                  setWinnerForm((prev) => ({
                                                    ...prev,
                                                    [c.id]: {
                                                      ...winnerRow(c.id),
                                                      qualifyingLotId:
                                                        evt.target.value,
                                                    },
                                                  }))
                                                }
                                                required
                                              >
                                                <option value="">
                                                  {'\u2014'} select a lot{' '}
                                                  {'\u2014'}
                                                </option>
                                                {activeProperties.map((p) => (
                                                  <option
                                                    key={p.id}
                                                    value={p.id}
                                                  >
                                                    {p.address}
                                                  </option>
                                                ))}
                                              </select>
                                            </div>
                                            <div
                                              className="field"
                                              style={{ margin: 0 }}
                                            >
                                              <label
                                                htmlFor={`start-day-${e.id}-${c.id}`}
                                              >
                                                Start day — {c.fullName}
                                              </label>
                                              <input
                                                id={`start-day-${e.id}-${c.id}`}
                                                type="date"
                                                value={row.startDay}
                                                onChange={(evt) =>
                                                  setWinnerForm((prev) => ({
                                                    ...prev,
                                                    [c.id]: {
                                                      ...winnerRow(c.id),
                                                      startDay:
                                                        evt.target.value,
                                                    },
                                                  }))
                                                }
                                                required
                                              />
                                            </div>
                                            <div
                                              className="field"
                                              style={{ margin: 0 }}
                                            >
                                              <label
                                                htmlFor={`scheduled-end-${e.id}-${c.id}`}
                                              >
                                                Scheduled end day — {c.fullName}
                                              </label>
                                              <input
                                                id={`scheduled-end-${e.id}-${c.id}`}
                                                type="date"
                                                value={row.scheduledEndDay}
                                                onChange={(evt) =>
                                                  setWinnerForm((prev) => ({
                                                    ...prev,
                                                    [c.id]: {
                                                      ...winnerRow(c.id),
                                                      scheduledEndDay:
                                                        evt.target.value,
                                                    },
                                                  }))
                                                }
                                                required
                                              />
                                            </div>
                                            <div
                                              className="field"
                                              style={{ margin: 0 }}
                                            >
                                              <label
                                                htmlFor={`winner-office-${e.id}-${c.id}`}
                                              >
                                                Office (optional) — {c.fullName}
                                              </label>
                                              <select
                                                id={`winner-office-${e.id}-${c.id}`}
                                                value={row.office}
                                                onChange={(evt) =>
                                                  setWinnerForm((prev) => ({
                                                    ...prev,
                                                    [c.id]: {
                                                      ...winnerRow(c.id),
                                                      office: evt.target.value,
                                                    },
                                                  }))
                                                }
                                              >
                                                <option value="">
                                                  {'\u2014'} none {'\u2014'}
                                                </option>
                                                <option value="president">
                                                  President
                                                </option>
                                                <option value="vice_president">
                                                  Vice President
                                                </option>
                                                <option value="secretary_treasurer">
                                                  Secretary-Treasurer
                                                </option>
                                              </select>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })
                              )}
                              <div className="btn-row">
                                <button
                                  className="btn btn--small"
                                  type="submit"
                                  disabled={busy}
                                >
                                  {busy ? 'Certifying…' : 'Certify election'}
                                </button>
                              </div>
                            </form>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
