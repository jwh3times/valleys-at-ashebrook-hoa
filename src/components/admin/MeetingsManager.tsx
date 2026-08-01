import { useEffect, useState } from 'react';
import {
  fetchMeetings,
  fetchMeeting,
  saveMeeting,
  deleteMeeting,
  approveMeeting,
  unapproveMeeting,
  setAttendance,
  setMemberAttendance,
  saveMotion,
  deleteMotion,
  setVotes,
  setMemberVotes,
  fetchBoardPeople,
  fetchProperties,
} from '../../lib/admin';
import {
  MEETING_BODIES,
  MEETING_KINDS,
  MOTION_OUTCOMES,
  VOTE_CHOICES,
  MEMBER_VOTE_CHOICES,
  tallyVotes,
} from '../../lib/types';
import type {
  MeetingSummary,
  MeetingDetail,
  MeetingBody,
  MeetingKind,
  MotionOutcome,
  VoteChoice,
  MemberVoteChoice,
  Visibility,
  BoardPersonWithTerms,
  PropertyWithOwners,
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

/** Per-property attendance draft for a member meeting. */
interface MemberAttendanceFormRow {
  present: boolean;
  representedByOwnerId: string;
  viaProxy: boolean;
}

/** Per-property vote draft for a member meeting's motion. */
interface MemberVoteFormRow {
  choice: MemberVoteChoice;
  castByOwnerId: string;
  viaProxy: boolean;
}

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

/**
 * Same reverse lookup as personIdByName, but for a property's owners:
 * MemberAttendanceRow/MemberVoteRow (the same shapes the public read
 * returns) carry the representing/casting owner's name, not id.
 */
function ownerIdByPropertyAndName(
  propertyId: string,
  name: string | null,
  properties: PropertyWithOwners[],
): string | null {
  if (!name) return null;
  const property = properties.find((p) => p.id === propertyId);
  return property?.owners.find((o) => o.fullName === name)?.id ?? null;
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

  // The property roster backs member-meeting attendance and vote editors —
  // their per-property twins of `people` above — loaded once alongside it.
  const [properties, setProperties] = useState<PropertyWithOwners[]>([]);
  useEffect(() => {
    fetchProperties()
      .then(setProperties)
      .catch((err: unknown) => {
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the property roster.';
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
  // Member-meeting twin of attendanceForm, keyed by propertyId instead of
  // personId, carrying the extra representedByOwnerId/viaProxy fields the
  // property-based editor needs.
  const [memberAttendanceForm, setMemberAttendanceForm] = useState<
    Record<string, MemberAttendanceFormRow>
  >({});
  const [motionForm, setMotionForm] = useState(emptyMotion);
  const [editingMotionId, setEditingMotionId] = useState<string | null>(null);
  const [voteForm, setVoteForm] = useState<Record<string, VoteChoice>>({});
  // Member-meeting twin of voteForm, keyed by propertyId.
  const [memberVoteForm, setMemberVoteForm] = useState<
    Record<string, MemberVoteFormRow>
  >({});

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
        setMemberAttendanceForm(
          Object.fromEntries(
            d.memberAttendance.map((a) => [
              a.propertyId,
              {
                present: a.present,
                representedByOwnerId:
                  ownerIdByPropertyAndName(
                    a.propertyId,
                    a.representedByName,
                    properties,
                  ) ?? '',
                viaProxy: a.viaProxy,
              },
            ]),
          ),
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
    setMemberVoteForm({});
  }

  function toggleExpand(meetingId: string) {
    setExpandedId((prev) => (prev === meetingId ? null : meetingId));
    setAttendanceForm({});
    setMemberAttendanceForm({});
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
    // Only one of votes/memberVotes is populated, depending on the parent
    // meeting's body — the other maps to an empty object, harmlessly.
    setMemberVoteForm(
      Object.fromEntries(
        motion.memberVotes.map((v) => [
          v.propertyId,
          {
            choice: v.choice,
            castByOwnerId:
              ownerIdByPropertyAndName(
                v.propertyId,
                v.castByName,
                properties,
              ) ?? '',
            viaProxy: v.viaProxy,
          },
        ]),
      ),
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

  async function submitAttendance(e: React.FormEvent, m: MeetingSummary) {
    e.preventDefault();
    await run(async () => {
      if (m.body === 'member') {
        // Full-replace: every property goes in, present or not — an
        // omitted property would silently drop its row.
        const entries = properties.map((p) => {
          const row = memberAttendanceForm[p.id];
          return {
            propertyId: p.id,
            present: !!row?.present,
            representedByOwnerId: row?.representedByOwnerId || null,
            viaProxy: !!row?.viaProxy,
          };
        });
        await setMemberAttendance(m.id, entries);
      } else {
        const entries = people.map((p) => ({
          personId: p.id,
          present: !!attendanceForm[p.id],
        }));
        await setAttendance(m.id, entries);
      }
      await reloadDetail(m.id);
    }, 'Attendance saved.');
  }

  const liveTally = tallyVotes(
    Object.values(voteForm).map((choice) => ({ choice })),
  );
  // Weighted, not a row count: each property contributes its own
  // voteWeight, so this will not equal the number of properties touched
  // whenever any property's weight differs from 1 — see the property roster.
  const liveMemberTally = tallyVotes(
    Object.entries(memberVoteForm).map(([propertyId, row]) => ({
      choice: row.choice,
      weight: properties.find((p) => p.id === propertyId)?.voteWeight ?? 1,
    })),
  );

  async function submitMotion(e: React.FormEvent, m: MeetingSummary) {
    e.preventDefault();
    const meetingId = m.id;
    await run(
      async () => {
        let motionId: string | undefined;
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
          motionId = editingMotionId;
        } else {
          motionId = await saveMotion({
            meetingId,
            text: motionForm.text,
            moverPersonId: motionForm.moverPersonId || null,
            secondPersonId: motionForm.secondPersonId || null,
            outcome: motionForm.outcome,
          });
        }
        if (motionId) {
          if (m.body === 'member') {
            // Full-replace: every property goes in, with an explicit
            // choice — MemberVoteChoice has no "not entered" state, so an
            // untouched property defaults to abstain rather than being
            // silently dropped from the ballot.
            const entries = properties.map((p) => {
              const row = memberVoteForm[p.id];
              return {
                propertyId: p.id,
                choice: row?.choice ?? ('abstain' as MemberVoteChoice),
                castByOwnerId: row?.castByOwnerId || null,
                viaProxy: !!row?.viaProxy,
              };
            });
            await setMemberVotes(motionId, entries);
          } else {
            const entries = Object.entries(voteForm).map(
              ([personId, choice]) => ({ personId, choice }),
            );
            await setVotes(motionId, entries);
          }
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
        Board and member meetings, who attended, and what was moved and how each
        vote went. A meeting starts as a draft and is published to the public
        site once approved. Board meetings record board attendance and a
        roll-call vote; member meetings record per-property attendance and votes
        weighted by each property&rsquo;s vote share.
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
          {meetingForm.body === 'member' && (
            <p className="muted" style={{ marginTop: '6px' }}>
              A member meeting&rsquo;s motion records list each property&rsquo;s
              address alongside how it voted — setting Visibility to Public
              makes that visible to anyone, not just homeowners.
            </p>
          )}
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
                  <button
                    className="row-link"
                    onClick={() => toggleExpand(m.id)}
                  >
                    {expandedId === m.id
                      ? 'Hide attendance & motions'
                      : 'Attendance & motions'}
                  </button>
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

              {expandedId === m.id && (
                <div style={{ paddingLeft: '18px', paddingTop: '10px' }}>
                  {m.body === 'board' ? (
                    <form
                      className="panel-card"
                      onSubmit={(e) => submitAttendance(e, m)}
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
                  ) : (
                    <form
                      className="panel-card"
                      onSubmit={(e) => submitAttendance(e, m)}
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="panel-editor__title">Attendance</div>
                      {properties.length === 0 ? (
                        <p className="muted">
                          No properties yet — add homes on The Roster tab.
                        </p>
                      ) : (
                        properties.map((p) => {
                          const row = memberAttendanceForm[p.id];
                          return (
                            <div key={p.id} style={{ marginBottom: '10px' }}>
                              <label
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={!!row?.present}
                                  onChange={(e) =>
                                    setMemberAttendanceForm((prev) => ({
                                      ...prev,
                                      [p.id]: {
                                        present: e.target.checked,
                                        representedByOwnerId:
                                          prev[p.id]?.representedByOwnerId ??
                                          '',
                                        viaProxy: prev[p.id]?.viaProxy ?? false,
                                      },
                                    }))
                                  }
                                />
                                {p.address}
                                {p.unit ? ` ${p.unit}` : ''}
                              </label>
                              {p.owners.length > 0 && (
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    paddingLeft: '26px',
                                    marginTop: '4px',
                                  }}
                                >
                                  <label
                                    htmlFor={`member-attendance-rep-${m.id}-${p.id}`}
                                  >
                                    Represented by — {p.address}
                                  </label>
                                  <select
                                    id={`member-attendance-rep-${m.id}-${p.id}`}
                                    value={row?.representedByOwnerId ?? ''}
                                    onChange={(e) =>
                                      setMemberAttendanceForm((prev) => ({
                                        ...prev,
                                        [p.id]: {
                                          present: prev[p.id]?.present ?? false,
                                          representedByOwnerId: e.target.value,
                                          viaProxy:
                                            prev[p.id]?.viaProxy ?? false,
                                        },
                                      }))
                                    }
                                  >
                                    <option value="">— none —</option>
                                    {p.owners.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.fullName}
                                      </option>
                                    ))}
                                  </select>
                                  <label
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={!!row?.viaProxy}
                                      onChange={(e) =>
                                        setMemberAttendanceForm((prev) => ({
                                          ...prev,
                                          [p.id]: {
                                            present:
                                              prev[p.id]?.present ?? false,
                                            representedByOwnerId:
                                              prev[p.id]
                                                ?.representedByOwnerId ?? '',
                                            viaProxy: e.target.checked,
                                          },
                                        }))
                                      }
                                    />
                                    Via proxy
                                  </label>
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
                          disabled={busy || properties.length === 0}
                        >
                          {busy ? 'Saving…' : 'Save attendance'}
                        </button>
                      </div>
                    </form>
                  )}

                  <form
                    className="panel-card"
                    onSubmit={(e) => submitMotion(e, m)}
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
                      {m.body === 'board' ? (
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
                      ) : (
                        <p
                          className="muted motion-tally"
                          data-testid="motion-tally"
                          style={{ marginTop: '6px' }}
                        >
                          {/* Weighted by each property's vote share — with
                              weights other than 1 this will not equal the
                              number of properties voted, by design. */}
                          Weighted tally: {liveMemberTally.yes} yes ·{' '}
                          {liveMemberTally.no} no · {liveMemberTally.abstain}{' '}
                          abstain
                          {!liveMemberTally.recorded &&
                            ' (no votes entered yet)'}
                        </p>
                      )}
                    </div>

                    {m.body === 'board'
                      ? people.length > 0 && (
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
                        )
                      : properties.length > 0 && (
                          <div style={{ marginBottom: '16px' }}>
                            <div className="panel-editor__title">Votes</div>
                            {properties.map((p) => {
                              const row = memberVoteForm[p.id];
                              return (
                                <div
                                  key={p.id}
                                  className="field"
                                  style={{ margin: '0 0 10px' }}
                                >
                                  <label
                                    htmlFor={`member-vote-${m.id}-${p.id}`}
                                  >
                                    Vote — {p.address}
                                  </label>
                                  <select
                                    id={`member-vote-${m.id}-${p.id}`}
                                    value={row?.choice ?? ''}
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      setMemberVoteForm((prev) => {
                                        const next = { ...prev };
                                        if (value === '') delete next[p.id];
                                        else
                                          next[p.id] = {
                                            choice: value as MemberVoteChoice,
                                            castByOwnerId:
                                              prev[p.id]?.castByOwnerId ?? '',
                                            viaProxy:
                                              prev[p.id]?.viaProxy ?? false,
                                          };
                                        return next;
                                      });
                                    }}
                                  >
                                    <option value="">— not entered —</option>
                                    {MEMBER_VOTE_CHOICES.map((c) => (
                                      <option key={c} value={c}>
                                        {VOTE_LABELS[c]}
                                      </option>
                                    ))}
                                  </select>
                                  {p.owners.length > 0 && (
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        marginTop: '4px',
                                      }}
                                    >
                                      <label
                                        htmlFor={`member-vote-cast-by-${m.id}-${p.id}`}
                                      >
                                        Cast by — {p.address}
                                      </label>
                                      <select
                                        id={`member-vote-cast-by-${m.id}-${p.id}`}
                                        value={row?.castByOwnerId ?? ''}
                                        onChange={(e) =>
                                          setMemberVoteForm((prev) => ({
                                            ...prev,
                                            [p.id]: {
                                              choice:
                                                prev[p.id]?.choice ?? 'abstain',
                                              castByOwnerId: e.target.value,
                                              viaProxy:
                                                prev[p.id]?.viaProxy ?? false,
                                            },
                                          }))
                                        }
                                      >
                                        <option value="">— none —</option>
                                        {p.owners.map((o) => (
                                          <option key={o.id} value={o.id}>
                                            {o.fullName}
                                          </option>
                                        ))}
                                      </select>
                                      <label
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: '4px',
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={!!row?.viaProxy}
                                          onChange={(e) =>
                                            setMemberVoteForm((prev) => ({
                                              ...prev,
                                              [p.id]: {
                                                choice:
                                                  prev[p.id]?.choice ??
                                                  'abstain',
                                                castByOwnerId:
                                                  prev[p.id]?.castByOwnerId ??
                                                  '',
                                                viaProxy: e.target.checked,
                                              },
                                            }))
                                          }
                                        />
                                        Via proxy
                                      </label>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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
                              {m.body === 'board' ? (
                                <>
                                  {OUTCOME_LABELS[mo.outcome]} · {mo.tally.yes}{' '}
                                  yes · {mo.tally.no} no · {mo.tally.abstain}{' '}
                                  abstain · {mo.tally.recused} recused ·{' '}
                                  {mo.tally.absent} absent
                                  {!mo.tally.recorded &&
                                    ' (no roll call recorded)'}
                                </>
                              ) : (
                                <>
                                  {OUTCOME_LABELS[mo.outcome]} · weighted{' '}
                                  {mo.memberTally.yes} yes · {mo.memberTally.no}{' '}
                                  no · {mo.memberTally.abstain} abstain
                                  {!mo.memberTally.recorded &&
                                    ' (no votes recorded)'}
                                </>
                              )}
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
