import { useEffect, useState } from 'react';
import {
  fetchMeetings,
  fetchMeeting,
  saveMeeting,
  deleteMeeting,
  approveMeeting,
  unapproveMeeting,
  setAttendance,
  saveMotion,
  deleteMotion,
  setVotes,
  fetchBoardPeople,
} from '../../lib/admin';
import {
  MEETING_BODIES,
  MEETING_KINDS,
  MOTION_OUTCOMES,
  VOTE_CHOICES,
  tallyVotes,
} from '../../lib/types';
import type {
  MeetingSummary,
  MeetingDetail,
  MeetingBody,
  MeetingKind,
  MotionOutcome,
  VoteChoice,
  Visibility,
  BoardPersonWithTerms,
  MotionDetail,
} from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const BODY_LABELS: Record<MeetingBody, string> = {
  board: 'Board',
  member: 'Member',
};
const KIND_LABELS: Record<MeetingKind, string> = {
  regular: 'Regular',
  special: 'Special',
  annual: 'Annual',
};
const OUTCOME_LABELS: Record<MotionOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  withdrawn: 'Withdrawn',
  tabled: 'Tabled',
};
const VOTE_LABELS: Record<VoteChoice, string> = {
  yes: 'Yes',
  no: 'No',
  abstain: 'Abstain',
  recused: 'Recused',
  absent: 'Absent',
};
const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'public', label: 'Public (everyone)' },
  { value: 'homeowner', label: 'Homeowners only' },
  { value: 'board', label: 'Board only' },
];

const emptyMeeting = {
  body: 'board' as MeetingBody,
  kind: 'regular' as MeetingKind,
  date: '',
  title: '',
  startTime: '',
  location: '',
  summaryMd: '',
  documentId: '',
  quorumRequired: '',
  visibility: 'board' as Visibility,
};

const emptyMotion = {
  text: '',
  moverPersonId: '',
  secondPersonId: '',
  outcome: 'passed' as MotionOutcome,
};

/**
 * Reverse lookup used only to pre-select a motion's mover/second when
 * opening it for edit: MotionDetail (the same shape the public read
 * returns) carries names, not ids. Votes don't need this — VoteRow already
 * carries personId directly.
 */
function personIdByName(
  name: string,
  people: BoardPersonWithTerms[],
): string | null {
  return people.find((p) => p.fullName === name)?.id ?? null;
}

export default function MeetingsManager() {
  const {
    data: meetings,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<MeetingSummary[]>(fetchMeetings, []);

  // The board roster backs attendance, mover/second pickers, and the roll
  // call — loaded once alongside the meetings, independent of useAdminResource
  // since it isn't the panel's primary save/delete target.
  const [people, setPeople] = useState<BoardPersonWithTerms[]>([]);
  useEffect(() => {
    fetchBoardPeople()
      .then(setPeople)
      .catch((err: unknown) => {
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the board roster.';
        setMsg('Error: ' + message);
      });
    // Load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [meetingForm, setMeetingForm] = useState(emptyMeeting);
  const [editingMeetingId, setEditingMeetingId] = useState<string | null>(null);
  // Set while startEditMeeting's detail fetch is in flight, so the "Edit"
  // button can show feedback without flashing blank fields into edit mode
  // before the meeting's real startTime/location/summaryMd/documentId/
  // quorumRequired — which MeetingSummary doesn't carry — have loaded.
  const [editDetailLoadingId, setEditDetailLoadingId] = useState<string | null>(
    null,
  );

  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The full MeetingDetail (attendance, motions, roll calls) for whichever
  // meeting is expanded, loaded via GET /api/admin/meetings?id= — the admin
  // detail read added alongside this panel so existing motions are editable,
  // not just visible-as-a-count.
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [attendanceForm, setAttendanceForm] = useState<Record<string, boolean>>(
    {},
  );
  const [motionForm, setMotionForm] = useState(emptyMotion);
  const [editingMotionId, setEditingMotionId] = useState<string | null>(null);
  const [voteForm, setVoteForm] = useState<Record<string, VoteChoice>>({});

  useEffect(() => {
    if (!expandedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchMeeting(expandedId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setAttendanceForm(
          Object.fromEntries(d.attendance.map((a) => [a.personId, a.present])),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the meeting.';
        setMsg('Error: ' + message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-run only when the expanded meeting changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);

  async function reloadDetail(meetingId: string) {
    const d = await fetchMeeting(meetingId);
    setDetail(d);
    return d;
  }

  function resetMeeting() {
    setEditingMeetingId(null);
    setMeetingForm(emptyMeeting);
  }
  function toTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function startEditMeeting(m: MeetingSummary) {
    setMsg('');
    setEditDetailLoadingId(m.id);
    try {
      // Prefill from the real MeetingDetail, not the summary row, so
      // startTime/location/summaryMd/documentId/quorumRequired — none of
      // which MeetingSummary carries — round-trip correctly on save instead
      // of being silently cleared.
      const full = await fetchMeeting(m.id);
      setEditingMeetingId(m.id);
      setMeetingForm({
        body: full.body,
        kind: full.kind,
        date: full.date,
        title: full.title,
        startTime: full.startTime ?? '',
        location: full.location ?? '',
        summaryMd: full.summaryMd ?? '',
        documentId: full.documentId ?? '',
        quorumRequired:
          full.quorumRequired === null ? '' : String(full.quorumRequired),
        visibility: full.visibility,
      });
      toTop();
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null)?.message ??
        'could not load the meeting.';
      setMsg('Error: ' + message);
    } finally {
      setEditDetailLoadingId(null);
    }
  }

  function resetMotion() {
    setEditingMotionId(null);
    setMotionForm(emptyMotion);
    setVoteForm({});
  }

  function toggleExpand(meetingId: string) {
    setExpandedId((prev) => (prev === meetingId ? null : meetingId));
    setAttendanceForm({});
    resetMotion();
    setMsg('');
  }

  function startEditMotion(motion: MotionDetail) {
    setEditingMotionId(motion.id);
    setMotionForm({
      text: motion.text,
      // MotionDetail carries names, not ids (it's the same shape the public
      // read returns) — the roll call's votes DO carry personId directly, so
      // only mover/second fall back to a name match against the roster. Board
      // rosters are small and names are effectively unique in practice; if a
      // match fails the field just starts blank rather than guessing wrong.
      moverPersonId: motion.moverName
        ? (personIdByName(motion.moverName, people) ?? '')
        : '',
      secondPersonId: motion.secondName
        ? (personIdByName(motion.secondName, people) ?? '')
        : '',
      outcome: motion.outcome,
    });
    setVoteForm(
      Object.fromEntries(motion.votes.map((v) => [v.personId, v.choice])),
    );
    setMsg('');
  }

  async function submitMeeting(e: React.FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        // Both create and edit send the full field set. On edit, the form was
        // seeded from the real MeetingDetail (see startEditMeeting), so a
        // blank field here means the board actually cleared it — that must
        // reach the server as an explicit null, not be dropped, or clearing
        // summaryMd (the minutes /meetings/[id] renders) would silently no-op.
        await saveMeeting(
          {
            body: meetingForm.body,
            kind: meetingForm.kind,
            date: meetingForm.date,
            title: meetingForm.title,
            startTime: meetingForm.startTime || null,
            location: meetingForm.location || null,
            summaryMd: meetingForm.summaryMd || null,
            documentId: meetingForm.documentId || null,
            quorumRequired: meetingForm.quorumRequired
              ? Number(meetingForm.quorumRequired)
              : null,
            visibility: meetingForm.visibility,
          },
          editingMeetingId ?? undefined,
        );
        resetMeeting();
        await reload();
      },
      editingMeetingId ? 'Meeting updated.' : 'Meeting added.',
    );
  }

  async function removeMeeting(m: MeetingSummary) {
    if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
    await run(async () => {
      await deleteMeeting(m.id);
      if (expandedId === m.id) setExpandedId(null);
      await reload();
    }, 'Meeting removed.');
  }

  async function handleApprove(m: MeetingSummary) {
    await run(async () => {
      await approveMeeting(m.id);
      await reload();
    }, 'Meeting approved.');
  }

  async function handleUnapprove(m: MeetingSummary) {
    await run(async () => {
      await unapproveMeeting(m.id);
      await reload();
    }, 'Meeting unapproved.');
  }

  async function submitAttendance(e: React.FormEvent, meetingId: string) {
    e.preventDefault();
    await run(async () => {
      const entries = people.map((p) => ({
        personId: p.id,
        present: !!attendanceForm[p.id],
      }));
      await setAttendance(meetingId, entries);
      await reloadDetail(meetingId);
    }, 'Attendance saved.');
  }

  const liveTally = tallyVotes(
    Object.values(voteForm).map((choice) => ({ choice })),
  );

  async function submitMotion(e: React.FormEvent, meetingId: string) {
    e.preventDefault();
    await run(
      async () => {
        const entries = Object.entries(voteForm).map(([personId, choice]) => ({
          personId,
          choice,
        }));
        if (editingMotionId) {
          await saveMotion(
            {
              text: motionForm.text,
              moverPersonId: motionForm.moverPersonId || null,
              secondPersonId: motionForm.secondPersonId || null,
              outcome: motionForm.outcome,
            },
            editingMotionId,
          );
          await setVotes(editingMotionId, entries);
        } else {
          const id = await saveMotion({
            meetingId,
            text: motionForm.text,
            moverPersonId: motionForm.moverPersonId || null,
            secondPersonId: motionForm.secondPersonId || null,
            outcome: motionForm.outcome,
          });
          if (id) await setVotes(id, entries);
        }
        resetMotion();
        await reload();
        await reloadDetail(meetingId);
      },
      editingMotionId ? 'Motion updated.' : 'Motion recorded.',
    );
  }

  async function removeMotion(meetingId: string, motion: MotionDetail) {
    if (!confirm(`Delete the motion "${motion.text}"? This cannot be undone.`))
      return;
    await run(async () => {
      await deleteMotion(motion.id);
      if (editingMotionId === motion.id) resetMotion();
      await reload();
      await reloadDetail(meetingId);
    }, 'Motion removed.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Meetings</h1>
      </div>
      <p className="admin-panel__intro">
        Board meetings, who attended, and what was moved and how each board
        member voted. A meeting starts as a draft and is published to the public
        site once approved. Only board meetings record attendance and votes here
        — member meetings arrive in a future release.
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
        onSubmit={submitMeeting}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">
          {editingMeetingId ? 'Edit Meeting' : 'Add Meeting'}
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-body">Body</label>
            <select
              id="meeting-body"
              value={meetingForm.body}
              onChange={(e) =>
                setMeetingForm({
                  ...meetingForm,
                  body: e.target.value as MeetingBody,
                })
              }
            >
              {MEETING_BODIES.map((b) => (
                <option key={b} value={b}>
                  {BODY_LABELS[b]}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-kind">Kind</label>
            <select
              id="meeting-kind"
              value={meetingForm.kind}
              onChange={(e) =>
                setMeetingForm({
                  ...meetingForm,
                  kind: e.target.value as MeetingKind,
                })
              }
            >
              {MEETING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-date">Date</label>
            <input
              id="meeting-date"
              type="date"
              value={meetingForm.date}
              onChange={(e) =>
                setMeetingForm({ ...meetingForm, date: e.target.value })
              }
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-title">Title</label>
            <input
              id="meeting-title"
              type="text"
              value={meetingForm.title}
              onChange={(e) =>
                setMeetingForm({ ...meetingForm, title: e.target.value })
              }
              placeholder="September meeting"
              required
            />
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-start-time">Start time (optional)</label>
            <input
              id="meeting-start-time"
              type="text"
              value={meetingForm.startTime}
              onChange={(e) =>
                setMeetingForm({
                  ...meetingForm,
                  startTime: e.target.value,
                })
              }
              placeholder="7:00 PM"
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-location">Location (optional)</label>
            <input
              id="meeting-location"
              type="text"
              value={meetingForm.location}
              onChange={(e) =>
                setMeetingForm({
                  ...meetingForm,
                  location: e.target.value,
                })
              }
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: '16px' }}>
          <label htmlFor="meeting-summary">Minutes (optional)</label>
          <textarea
            id="meeting-summary"
            value={meetingForm.summaryMd}
            onChange={(e) =>
              setMeetingForm({
                ...meetingForm,
                summaryMd: e.target.value,
              })
            }
          />
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-document">
              Linked minutes document ID (optional)
            </label>
            <input
              id="meeting-document"
              type="text"
              value={meetingForm.documentId}
              onChange={(e) =>
                setMeetingForm({
                  ...meetingForm,
                  documentId: e.target.value,
                })
              }
              placeholder="From the Documents tab"
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="meeting-quorum">Quorum required (optional)</label>
            <input
              id="meeting-quorum"
              type="number"
              min="0"
              step="1"
              value={meetingForm.quorumRequired}
              onChange={(e) =>
                setMeetingForm({
                  ...meetingForm,
                  quorumRequired: e.target.value,
                })
              }
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: '16px' }}>
          <label htmlFor="meeting-visibility">Visibility</label>
          <select
            id="meeting-visibility"
            value={meetingForm.visibility}
            onChange={(e) =>
              setMeetingForm({
                ...meetingForm,
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
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy
              ? 'Saving…'
              : editingMeetingId
                ? 'Save Meeting'
                : 'Add Meeting'}
          </button>
          {editingMeetingId && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetMeeting}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : meetings.length === 0 ? (
          <p className="muted panel-pad">No meetings recorded yet.</p>
        ) : (
          meetings.map((m) => (
            <div
              key={m.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">
                    {m.title}{' '}
                    <span className="pinned-badge">
                      {m.status === 'approved' ? 'Approved' : 'Draft'}
                    </span>
                  </div>
                  <div className="admin-row-sub">
                    {m.date} · {BODY_LABELS[m.body]} {KIND_LABELS[m.kind]}{' '}
                    meeting · {m.motionCount}{' '}
                    {m.motionCount === 1 ? 'motion' : 'motions'}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="row-link"
                    disabled={editDetailLoadingId === m.id}
                    onClick={() => startEditMeeting(m)}
                  >
                    {editDetailLoadingId === m.id ? 'Loading…' : 'Edit'}
                  </button>
                  {m.body === 'board' && (
                    <button
                      className="row-link"
                      onClick={() => toggleExpand(m.id)}
                    >
                      {expandedId === m.id
                        ? 'Hide attendance & motions'
                        : 'Attendance & motions'}
                    </button>
                  )}
                  {m.status === 'approved' ? (
                    <button
                      className="row-link"
                      onClick={() => handleUnapprove(m)}
                    >
                      Unapprove
                    </button>
                  ) : (
                    <button
                      className="row-link"
                      onClick={() => handleApprove(m)}
                    >
                      Approve
                    </button>
                  )}
                  <button
                    className="row-link row-link--danger"
                    aria-label={`Delete ${m.title}`}
                    onClick={() => removeMeeting(m)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {m.body === 'member' && (
                <p
                  className="muted"
                  style={{ paddingLeft: '18px', paddingTop: '6px' }}
                >
                  Member meeting — attendance and voting arrive in a future
                  release.
                </p>
              )}

              {expandedId === m.id && m.body === 'board' && (
                <div style={{ paddingLeft: '18px', paddingTop: '10px' }}>
                  <form
                    className="panel-card"
                    onSubmit={(e) => submitAttendance(e, m.id)}
                    style={{ marginBottom: '14px' }}
                  >
                    <div className="panel-editor__title">Attendance</div>
                    {people.length === 0 ? (
                      <p className="muted">
                        No board roster yet — add people on The Board tab.
                      </p>
                    ) : (
                      people.map((p) => (
                        <label
                          key={p.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            marginBottom: '6px',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!attendanceForm[p.id]}
                            onChange={(e) =>
                              setAttendanceForm((prev) => ({
                                ...prev,
                                [p.id]: e.target.checked,
                              }))
                            }
                          />
                          {p.fullName}
                        </label>
                      ))
                    )}
                    <div className="btn-row">
                      <button
                        className="btn btn--small"
                        type="submit"
                        disabled={busy || people.length === 0}
                      >
                        {busy ? 'Saving…' : 'Save attendance'}
                      </button>
                    </div>
                  </form>

                  <form
                    className="panel-card"
                    onSubmit={(e) => submitMotion(e, m.id)}
                    style={{ marginBottom: '14px' }}
                  >
                    <div className="panel-editor__title">
                      {editingMotionId ? 'Edit motion' : 'Add motion'}
                    </div>
                    <div className="field" style={{ marginBottom: '16px' }}>
                      <label htmlFor={`motion-text-${m.id}`}>Motion</label>
                      <textarea
                        id={`motion-text-${m.id}`}
                        value={motionForm.text}
                        onChange={(e) =>
                          setMotionForm({
                            ...motionForm,
                            text: e.target.value,
                          })
                        }
                        required
                      />
                    </div>
                    <div
                      className="field-grid"
                      style={{ marginBottom: '16px' }}
                    >
                      <div className="field" style={{ margin: 0 }}>
                        <label htmlFor={`motion-mover-${m.id}`}>
                          Moved by (optional)
                        </label>
                        <select
                          id={`motion-mover-${m.id}`}
                          value={motionForm.moverPersonId}
                          onChange={(e) =>
                            setMotionForm({
                              ...motionForm,
                              moverPersonId: e.target.value,
                            })
                          }
                        >
                          <option value="">— none —</option>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.fullName}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field" style={{ margin: 0 }}>
                        <label htmlFor={`motion-second-${m.id}`}>
                          Seconded by (optional)
                        </label>
                        <select
                          id={`motion-second-${m.id}`}
                          value={motionForm.secondPersonId}
                          onChange={(e) =>
                            setMotionForm({
                              ...motionForm,
                              secondPersonId: e.target.value,
                            })
                          }
                        >
                          <option value="">— none —</option>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.fullName}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="field" style={{ marginBottom: '16px' }}>
                      <label htmlFor={`motion-outcome-${m.id}`}>Outcome</label>
                      <select
                        id={`motion-outcome-${m.id}`}
                        value={motionForm.outcome}
                        onChange={(e) =>
                          setMotionForm({
                            ...motionForm,
                            outcome: e.target.value as MotionOutcome,
                          })
                        }
                      >
                        {MOTION_OUTCOMES.map((o) => (
                          <option key={o} value={o}>
                            {OUTCOME_LABELS[o]}
                          </option>
                        ))}
                      </select>
                      {/* Live tally, derived from the roll call being entered
                          below — never fetched. The board enters the outcome
                          and the tally sits right beside it so a mismatch
                          between the two is visible to whoever is typing;
                          the server does not enforce that they agree. */}
                      <p
                        className="muted motion-tally"
                        data-testid="motion-tally"
                        style={{ marginTop: '6px' }}
                      >
                        Tally: {liveTally.yes} yes · {liveTally.no} no ·{' '}
                        {liveTally.abstain} abstain · {liveTally.recused}{' '}
                        recused · {liveTally.absent} absent
                        {!liveTally.recorded && ' (no roll call entered yet)'}
                      </p>
                    </div>

                    {people.length > 0 && (
                      <div style={{ marginBottom: '16px' }}>
                        <div className="panel-editor__title">Roll call</div>
                        {people.map((p) => (
                          <div
                            key={p.id}
                            className="field"
                            style={{ margin: '0 0 10px' }}
                          >
                            <label htmlFor={`vote-${m.id}-${p.id}`}>
                              Vote — {p.fullName}
                            </label>
                            <select
                              id={`vote-${m.id}-${p.id}`}
                              value={voteForm[p.id] ?? ''}
                              onChange={(e) => {
                                const value = e.target.value;
                                setVoteForm((prev) => {
                                  const next = { ...prev };
                                  if (value === '') delete next[p.id];
                                  else next[p.id] = value as VoteChoice;
                                  return next;
                                });
                              }}
                            >
                              <option value="">— not entered —</option>
                              {VOTE_CHOICES.map((c) => (
                                <option key={c} value={c}>
                                  {VOTE_LABELS[c]}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="btn-row">
                      <button
                        className="btn btn--small"
                        type="submit"
                        disabled={busy}
                      >
                        {busy
                          ? 'Saving…'
                          : editingMotionId
                            ? 'Save motion'
                            : 'Add motion'}
                      </button>
                      {editingMotionId && (
                        <button
                          type="button"
                          className="btn btn--outline btn--small"
                          onClick={resetMotion}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </form>

                  <div className="panel-card">
                    <div className="panel-editor__title">Motions</div>
                    {detailLoading && !detail ? (
                      <p className="muted">Loading motions…</p>
                    ) : (detail?.motions.length ?? 0) === 0 ? (
                      <p className="muted">No motions recorded yet.</p>
                    ) : (
                      detail!.motions.map((mo) => (
                        <div key={mo.id} className="list-row">
                          <div className="admin-row-main">
                            <div className="admin-row-title">{mo.text}</div>
                            <div className="admin-row-sub">
                              {OUTCOME_LABELS[mo.outcome]} · {mo.tally.yes} yes
                              · {mo.tally.no} no · {mo.tally.abstain} abstain ·{' '}
                              {mo.tally.recused} recused · {mo.tally.absent}{' '}
                              absent
                              {!mo.tally.recorded && ' (no roll call recorded)'}
                            </div>
                          </div>
                          <div className="row-actions">
                            <button
                              className="row-link"
                              aria-label={`Edit motion ${mo.text}`}
                              onClick={() => startEditMotion(mo)}
                            >
                              Edit
                            </button>
                            <button
                              className="row-link row-link--danger"
                              aria-label={`Delete motion ${mo.text}`}
                              onClick={() => removeMotion(m.id, mo)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
