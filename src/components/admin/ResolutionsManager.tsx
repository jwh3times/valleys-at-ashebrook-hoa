import { useEffect, useState } from 'react';
import {
  fetchResolutions,
  saveResolution,
  deleteResolution,
  adoptResolution,
  supersedeResolution,
  repealResolution,
  fetchMeetings,
  fetchMeeting,
} from '../../lib/admin';
import type {
  ResolutionDetail,
  ResolutionStatus,
  Visibility,
} from '../../lib/types';
import { useAdminResource } from './useAdminResource';

// Render order for the list: a board member's question is almost always
// "what is in force", so that group leads, followed by the two closed
// states, with drafts (not yet part of the record) last.
const STATUS_GROUPS: { status: ResolutionStatus; label: string }[] = [
  { status: 'in_force', label: 'In force' },
  { status: 'superseded', label: 'Superseded' },
  { status: 'repealed', label: 'Repealed' },
  { status: 'draft', label: 'Drafts' },
];

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'public', label: 'Public (everyone)' },
  { value: 'homeowner', label: 'Homeowners only' },
  { value: 'board', label: 'Board only' },
];

const emptyResolution = {
  number: '',
  title: '',
  bodyMd: '',
  effectiveDate: '',
  visibility: 'board' as Visibility,
};

// Shared draft for both transition mini-forms below the main editor.
// supersedesId is unused by the adopt form; effectiveDate/motionId are
// shared by both.
const emptyTransition = { effectiveDate: '', motionId: '', supersedesId: '' };

export default function ResolutionsManager() {
  const {
    data: resolutions,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<ResolutionDetail[]>(fetchResolutions, []);

  const [form, setForm] = useState(emptyResolution);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Which draft resolution is mid-transition, and which transition — status
  // itself is never offered as a form field (see the invariant this panel
  // exists to protect): adopt/supersede are the only ways a draft ever
  // leaves that state, and each needs a required effective date the server
  // won't infer, so they get a small inline form instead of a one-click button.
  const [transitionId, setTransitionId] = useState<string | null>(null);
  const [transitionKind, setTransitionKind] = useState<
    'adopt' | 'supersede' | null
  >(null);
  const [transitionForm, setTransitionForm] = useState(emptyTransition);

  // The supersede picker only offers currently-in-force resolutions — a
  // draft or already-closed resolution can't be a legal predecessor, and
  // the route would reject anything else with a 409 anyway.
  const inForce = resolutions.filter((r) => r.status === 'in_force');

  // Flattened motion picker for the adopt/supersede transitions and for
  // resolving an already-recorded adoptedByMotionId back to something
  // human. There is no bulk "every motion" read, so this fetches the
  // meeting list, then — for meetings that actually have motions — their
  // full detail, and flattens. fetchMeetings already returns newest-first
  // (see fetchAdminMeetings), so this preserves that order without
  // re-sorting.
  const [motionOptions, setMotionOptions] = useState<
    { id: string; label: string }[]
  >([]);
  useEffect(() => {
    // React's documented mount-fetch shape: the load runs in a function
    // declared inside the effect and guarded by `cancelled`, which the cleanup
    // flips so a late response can't write state.
    let cancelled = false;
    async function loadMotionOptions() {
      try {
        const meetingList = await fetchMeetings();
        const withMotions = meetingList.filter((m) => m.motionCount > 0);
        const details = await Promise.all(
          withMotions.map((m) => fetchMeeting(m.id)),
        );
        if (cancelled) return;
        setMotionOptions(
          details.flatMap((d) =>
            d.motions.map((mo) => ({
              id: mo.id,
              label: `${d.date} — ${mo.text}`,
            })),
          ),
        );
      } catch (err: unknown) {
        if (cancelled) return;
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load motions.';
        setMsg('Error: ' + message);
      }
    }
    void loadMotionOptions();
    return () => {
      cancelled = true;
    };
  }, [setMsg]);

  // Resolves a resolution's adoptedByMotionId to the same "date — motion
  // text" shape the picker uses, never the bare id — a board member reading
  // the list has no use for a UUID.
  function motionLabel(motionId: string | null): string | null {
    if (!motionId) return null;
    return motionOptions.find((o) => o.id === motionId)?.label ?? null;
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyResolution);
  }
  function resetTransition() {
    setTransitionId(null);
    setTransitionKind(null);
    setTransitionForm(emptyTransition);
  }
  function toTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEdit(r: ResolutionDetail) {
    resetTransition();
    setEditingId(r.id);
    setForm({
      number: r.number,
      title: r.title,
      bodyMd: r.bodyMd,
      effectiveDate: r.effectiveDate ?? '',
      visibility: r.visibility,
    });
    setMsg('');
    toTop();
  }

  function startAdopt(r: ResolutionDetail) {
    resetForm();
    setTransitionId(r.id);
    setTransitionKind('adopt');
    setTransitionForm(emptyTransition);
    setMsg('');
  }

  function startSupersede(r: ResolutionDetail) {
    resetForm();
    setTransitionId(r.id);
    setTransitionKind('supersede');
    setTransitionForm(emptyTransition);
    setMsg('');
  }

  async function submitResolution(e: React.FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        await saveResolution(
          {
            number: form.number,
            title: form.title,
            bodyMd: form.bodyMd,
            effectiveDate: form.effectiveDate || null,
            visibility: form.visibility,
          },
          editingId ?? undefined,
        );
        resetForm();
        await reload();
      },
      editingId ? 'Resolution updated.' : 'Resolution added.',
    );
  }

  async function submitTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!transitionId || !transitionKind) return;
    const id = transitionId;
    const kind = transitionKind;
    await run(
      async () => {
        if (kind === 'adopt') {
          await adoptResolution(
            id,
            transitionForm.effectiveDate,
            transitionForm.motionId || undefined,
          );
        } else {
          await supersedeResolution(
            id,
            transitionForm.supersedesId,
            transitionForm.effectiveDate,
            transitionForm.motionId || undefined,
          );
        }
        resetTransition();
        await reload();
      },
      kind === 'adopt' ? 'Resolution adopted.' : 'Resolution now in force.',
    );
  }

  async function handleRepeal(r: ResolutionDetail) {
    if (!confirm(`Repeal "${r.number} — ${r.title}"? This cannot be undone.`))
      return;
    await run(async () => {
      await repealResolution(r.id);
      await reload();
    }, 'Resolution repealed.');
  }

  async function handleDelete(r: ResolutionDetail) {
    if (!confirm(`Delete "${r.number} — ${r.title}"? This cannot be undone.`))
      return;
    await run(async () => {
      await deleteResolution(r.id);
      await reload();
    }, 'Resolution deleted.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Resolutions</h1>
      </div>
      <p className="admin-panel__intro">
        Standing rules the board adopts. A resolution starts as a draft, is
        adopted into force — optionally superseding an earlier one — and can
        later be repealed. Each step is a deliberate action, not an edit, so the
        chain stays a legible record of what preceded it.
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
        onSubmit={submitResolution}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">
          {editingId ? 'Edit Resolution' : 'Add Resolution'}
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="resolution-number">Number</label>
            <input
              id="resolution-number"
              type="text"
              value={form.number}
              onChange={(e) => setForm({ ...form, number: e.target.value })}
              placeholder="2024-01"
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="resolution-title">Title</label>
            <input
              id="resolution-title"
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: '16px' }}>
          <label htmlFor="resolution-body">Text</label>
          <textarea
            id="resolution-body"
            value={form.bodyMd}
            onChange={(e) => setForm({ ...form, bodyMd: e.target.value })}
            required
          />
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="resolution-effective-date">
              Effective date (optional)
            </label>
            <input
              id="resolution-effective-date"
              type="date"
              value={form.effectiveDate}
              onChange={(e) =>
                setForm({ ...form, effectiveDate: e.target.value })
              }
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="resolution-visibility">Visibility</label>
            <select
              id="resolution-visibility"
              value={form.visibility}
              onChange={(e) =>
                setForm({ ...form, visibility: e.target.value as Visibility })
              }
            >
              {VISIBILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy
              ? 'Saving…'
              : editingId
                ? 'Save Resolution'
                : 'Add Resolution'}
          </button>
          {editingId && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetForm}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {transitionId && transitionKind && (
        <form
          className="panel-card"
          onSubmit={submitTransition}
          style={{ marginBottom: '26px' }}
        >
          <div className="panel-editor__title">
            {transitionKind === 'adopt'
              ? 'Adopt resolution'
              : 'Supersede with this resolution'}
          </div>
          {transitionKind === 'supersede' && (
            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="transition-supersedes">Supersedes</label>
              <select
                id="transition-supersedes"
                value={transitionForm.supersedesId}
                onChange={(e) =>
                  setTransitionForm({
                    ...transitionForm,
                    supersedesId: e.target.value,
                  })
                }
                required
              >
                <option value="">— choose a resolution in force —</option>
                {inForce.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number} — {r.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="transition-effective-date">Effective date</label>
              <input
                id="transition-effective-date"
                type="date"
                value={transitionForm.effectiveDate}
                onChange={(e) =>
                  setTransitionForm({
                    ...transitionForm,
                    effectiveDate: e.target.value,
                  })
                }
                required
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="transition-motion">Motion (optional)</label>
              <select
                id="transition-motion"
                value={transitionForm.motionId}
                onChange={(e) =>
                  setTransitionForm({
                    ...transitionForm,
                    motionId: e.target.value,
                  })
                }
              >
                <option value="">— no motion —</option>
                {motionOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy
                ? 'Saving…'
                : transitionKind === 'adopt'
                  ? 'Confirm adopt'
                  : 'Confirm supersede'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetTransition}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : resolutions.length === 0 ? (
          <p className="muted panel-pad">No resolutions yet.</p>
        ) : (
          STATUS_GROUPS.map(({ status, label }) => {
            const group = resolutions.filter((r) => r.status === status);
            if (group.length === 0) return null;
            return (
              <div key={status} style={{ marginBottom: '22px' }}>
                <h2 style={{ marginBottom: '10px' }}>{label}</h2>
                {group.map((r) => (
                  <div
                    key={r.id}
                    className="panel-card"
                    style={{ marginBottom: '14px' }}
                  >
                    <div className="list-row">
                      <div className="admin-row-main">
                        <div className="admin-row-title">
                          {r.number} — {r.title}
                        </div>
                        <div className="admin-row-sub">
                          {r.effectiveDate
                            ? `Effective ${r.effectiveDate}`
                            : 'No effective date set'}
                          {r.status === 'superseded' &&
                            r.supersededByNumber &&
                            ` · superseded by ${r.supersededByNumber}`}
                        </div>
                        {r.adoptedByMotionId && (
                          <div className="admin-row-sub">
                            Adopted by motion:{' '}
                            {motionLabel(r.adoptedByMotionId) ??
                              'motion record unavailable'}
                          </div>
                        )}
                      </div>
                      <div className="row-actions">
                        <button
                          className="row-link"
                          aria-label={`Edit resolution: ${r.number}`}
                          onClick={() => startEdit(r)}
                        >
                          Edit
                        </button>
                        {r.status === 'draft' && (
                          <>
                            <button
                              className="row-link"
                              aria-label={`Adopt resolution: ${r.number}`}
                              onClick={() => startAdopt(r)}
                            >
                              Adopt
                            </button>
                            {inForce.length > 0 && (
                              <button
                                className="row-link"
                                aria-label={`Supersede resolution: ${r.number}`}
                                onClick={() => startSupersede(r)}
                              >
                                Supersede…
                              </button>
                            )}
                            <button
                              className="row-link row-link--danger"
                              aria-label={`Delete ${r.number}`}
                              onClick={() => handleDelete(r)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                        {r.status === 'in_force' && (
                          <button
                            className="row-link row-link--danger"
                            aria-label={`Repeal ${r.number}`}
                            onClick={() => handleRepeal(r)}
                          >
                            Repeal
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
