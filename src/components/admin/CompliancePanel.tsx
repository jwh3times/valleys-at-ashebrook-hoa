import { useState } from 'react';
import {
  fetchAccessDenials,
  fetchAuditIntegrity,
  fetchRedactions,
  isCapabilityRefusal,
  recordRedactionCleanup,
  redactContactMethod,
  redactPersonName,
} from '../../lib/roster-admin';
import type {
  AccessDenialRow,
  AccessGrantAction,
  AuditIntegrityView,
  AuditIntegrityViolation,
  BoardEligibilityViolation,
  RedactionAuthorityKind,
  RedactionComplianceRow,
  RedactionFieldCategory,
  RedactionsView,
  RedactionTaskRow,
  RedactionTaskTargetKind,
} from '../../lib/roster-admin';
import { useAdminResource } from './useAdminResource';

// The Compliance panel is the working surface for the four
// System-Administrator-only technical capabilities (#205, #217). Every read it
// makes answers 403 for every caller under `cutover_mode = legacy`, because
// System Administration is a new-model concept with no legacy equivalent — so
// the dark panel has to explain itself rather than look broken. That is the
// capability-required card below, not an error state.

interface ComplianceView {
  redactions: RedactionsView;
  denials: AccessDenialRow[];
  integrity: AuditIntegrityView;
}

const EMPTY: ComplianceView = {
  redactions: { compliance: [], tasks: [] },
  denials: [],
  integrity: { auditViolations: [], boardEligibilityViolations: [] },
};

// One load for the whole panel: the three reads are gated on three different
// capabilities, but a caller either holds all four (a System Administrator) or
// none, so splitting them into three independent load states would buy three
// ways to render the same answer.
async function loadCompliance(): Promise<ComplianceView> {
  const [redactions, denials, integrity] = await Promise.all([
    fetchRedactions(),
    fetchAccessDenials(),
    fetchAuditIntegrity(),
  ]);
  return { redactions, denials, integrity };
}

const FIELD_CATEGORY: Record<RedactionFieldCategory, string> = {
  person_name: 'Person name',
  email: 'Email address',
  phone: 'Phone number',
};

const TASK_TARGET: Record<RedactionTaskTargetKind, string> = {
  rag_corpus: 'RAG corpus',
  ai_search_index: 'AI Search index',
  pseudonymizer_catalog: 'Pseudonymizer catalog',
  export_cache: 'Export cache',
};

const AUTHORITY_KIND: Record<RedactionAuthorityKind, string> = {
  legal_requirement: 'Legal requirement',
  binding_policy: 'Binding policy',
};

const REQUESTED_ACTION: Record<AccessGrantAction, string> = {
  grant: 'Grant access',
  revoke: 'Revoke access',
  bootstrap: 'Bootstrap first System Administrator',
  roster_export: 'Export the roster',
  last_administrator_change: 'Change the last System Administrator',
  grant_precondition_revalidation: 'Re-validate a live grant',
};

const AUDIT_VIOLATION: Record<AuditIntegrityViolation, string> = {
  detail_cardinality:
    'An event carries no typed detail row, or more than one — a writer bypassed its atomic batch.',
  causal_order:
    'A cause points outside its own correlation, or forward in local order.',
  orphan_correction: 'A correction points at an event that does not exist.',
  redaction_incomplete:
    'A redaction is missing its evidence row or its cleanup task.',
  flag_without_opening_event: 'A review flag that no review event ever opened.',
};

const BOARD_VIOLATION: Record<BoardEligibilityViolation, string> = {
  current_term_without_qualifying_lot:
    'An unconcluded term records no qualifying lot.',
  qualifying_basis_missing:
    'The qualifying lot is no longer owned or represented by this person.',
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

type RedactionTarget = 'person' | 'contact_method';

const TARGET_LABEL: Record<RedactionTarget, string> = {
  person: "this person's name",
  contact_method: "this contact method's value",
};

const emptyRedaction = {
  target: 'person' as RedactionTarget,
  targetId: '',
  authorityKind: 'legal_requirement' as RedactionAuthorityKind,
  authorityReference: '',
  reason: '',
};

/**
 * The wording a System Administrator has to agree to. Redaction is the one
 * action on this surface that destroys data: the value goes NULL in place and
 * every viewer, the board included, sees the durable-id fallback from then on.
 * There is no undo, so the confirm says so in those words rather than the
 * usual "this cannot be undone" boilerplate.
 */
function redactionConfirmText(target: RedactionTarget): string {
  return (
    `Redact ${TARGET_LABEL[target]}?\n\n` +
    'This is IRREVERSIBLE. The value is permanently removed for every viewer, ' +
    'including the board — nothing restores it, and the record shows only a ' +
    'durable id from now on.\n\n' +
    'The redaction itself is permanently recorded, and downstream copies must ' +
    'still be purged through the cleanup tasks below.'
  );
}

function ComplianceRow({ row }: { row: RedactionComplianceRow }) {
  const target = row.target_person_id
    ? `Person ${row.target_person_id}`
    : row.target_contact_method_id
      ? `Contact method ${row.target_contact_method_id}`
      : 'Unknown target';
  return (
    <div className="list-row">
      <div className="admin-row-main">
        <div className="admin-row-title">
          {FIELD_CATEGORY[row.field_category]} &middot; {target}
        </div>
        <div className="admin-row-sub">
          {AUTHORITY_KIND[row.authority_kind]}: {row.authority_reference}{' '}
          &middot; reason {row.reason_code}
        </div>
        <div className="admin-row-sub">
          Authorized by {row.authorized_by_account_id}
          {row.performed_by_account_id
            ? ` · performed by ${row.performed_by_account_id}`
            : ''}
        </div>
        <div className="admin-row-sub">
          {row.task_count} cleanup task(s) &middot; {row.tasks_pending} pending
          &middot; {row.tasks_failed} failed
        </div>
      </div>
      <div className="admin-row-date">{moment(row.recorded_at)}</div>
    </div>
  );
}

function TaskRow({
  task,
  busy,
  onCleanup,
}: {
  task: RedactionTaskRow;
  busy: boolean;
  onCleanup: (task: RedactionTaskRow, status: 'succeeded' | 'failed') => void;
}) {
  return (
    <div className="list-row">
      <div className="admin-row-main">
        <div className="admin-row-title">
          {TASK_TARGET[task.target_kind]} &middot; {task.status}
        </div>
        <div className="admin-row-sub">
          Target {task.target_identifier} &middot; {task.attempts} attempt(s)
          {task.last_error_code ? ` · last error ${task.last_error_code}` : ''}
        </div>
        <div className="admin-row-sub">
          Opened {moment(task.created_at)}
          {task.completed_at ? ` · completed ${moment(task.completed_at)}` : ''}
        </div>
      </div>
      {task.status !== 'succeeded' && (
        <div className="row-actions">
          <button
            className="row-link"
            aria-label={`Record purged: ${TASK_TARGET[task.target_kind]} cleanup for ${task.target_identifier}`}
            disabled={busy}
            onClick={() => onCleanup(task, 'succeeded')}
          >
            Record purged
          </button>
          <button
            className="row-link row-link--danger"
            aria-label={`Record failed: ${TASK_TARGET[task.target_kind]} cleanup for ${task.target_identifier}`}
            disabled={busy}
            onClick={() => onCleanup(task, 'failed')}
          >
            Record failed
          </button>
        </div>
      )}
    </div>
  );
}

function DenialRow({ row }: { row: AccessDenialRow }) {
  return (
    <div className="list-row">
      <div className="admin-row-main">
        <div className="admin-row-title">
          {REQUESTED_ACTION[row.requested_action] ?? row.requested_action}
          {row.grant_type
            ? ` · ${row.grant_type === 'board' ? 'board' : 'system administrator'} grant`
            : ''}
        </div>
        <div className="admin-row-sub">
          Refused{row.reason_code ? `: ${row.reason_code}` : ''} &middot; event{' '}
          {row.event_kind}
        </div>
        <div className="admin-row-sub">
          Attempted by {row.actor_account_id ?? 'an unattributed actor'}
          {row.target_account_id ? ` · target ${row.target_account_id}` : ''}
          {row.access_grant_id ? ` · grant ${row.access_grant_id}` : ''}
        </div>
      </div>
      <div className="admin-row-date">{moment(row.recorded_at)}</div>
    </div>
  );
}

export default function CompliancePanel() {
  const { data, loading, loadError, reload, busy, msg, setMsg, run } =
    useAdminResource<ComplianceView>(loadCompliance, EMPTY);

  const [form, setForm] = useState(emptyRedaction);

  const { compliance, tasks } = data.redactions;
  const { auditViolations, boardEligibilityViolations } = data.integrity;

  async function submitRedaction(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(redactionConfirmText(form.target))) return;
    const authority = {
      authorityKind: form.authorityKind,
      authorityReference: form.authorityReference.trim(),
      reason: form.reason.trim(),
    };
    const targetId = form.targetId.trim();
    await run(async () => {
      if (form.target === 'person')
        await redactPersonName({ personId: targetId, ...authority });
      else
        await redactContactMethod({
          contactMethodId: targetId,
          ...authority,
        });
      setForm(emptyRedaction);
      await reload();
    }, 'Value redacted. Purge the downstream copies, then record each cleanup task below.');
  }

  async function handleCleanup(
    task: RedactionTaskRow,
    status: 'succeeded' | 'failed',
  ) {
    await run(
      async () => {
        await recordRedactionCleanup({ taskId: task.id, status });
        await reload();
      },
      status === 'succeeded' ? 'Cleanup recorded.' : 'Failure recorded.',
    );
  }

  if (loading)
    return (
      <div className="admin-panel">
        <div className="admin-bar">
          <h1>Compliance</h1>
        </div>
        <p className="loading panel-pad">Loading compliance record…</p>
      </div>
    );

  // The expected answer before the cutover, not a failure: nobody holds the
  // four technical capabilities while `cutover_mode` reads `legacy`.
  if (isCapabilityRefusal(loadError))
    return (
      <div className="admin-panel">
        <div className="admin-bar">
          <h1>Compliance</h1>
        </div>
        <div className="panel-card">
          <div className="panel-editor__title">
            Requires System Administrator access
          </div>
          <p>
            This panel shows redaction evidence, denied privileged access
            attempts, and the audit integrity views. Each is restricted to a
            System Administrator.
          </p>
          <p className="muted">
            System Administrator access is granted at the ADR 0022 cutover — no
            account holds it before then, including yours. Nothing is wrong with
            this panel or with your board access; there is simply nothing here
            for anyone to see yet.
          </p>
        </div>
      </div>
    );

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Compliance</h1>
      </div>
      <p className="admin-panel__intro">
        The System Administrator surface: what has been redacted and whether the
        downstream copies were purged, every privileged act that was refused,
        and the two integrity views over the audit ledger.
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
        onSubmit={submitRedaction}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">Redact a value</div>
        <p className="admin-row-sub" style={{ marginBottom: '16px' }}>
          Redaction is irreversible: the value is permanently removed for every
          viewer, including the board. Record the authority you are acting
          under; the value itself never enters the ledger.
        </p>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="redaction-target">What to redact</label>
            <select
              id="redaction-target"
              value={form.target}
              onChange={(e) =>
                setForm({
                  ...form,
                  target: e.target.value as RedactionTarget,
                  targetId: '',
                })
              }
            >
              <option value="person">A person&rsquo;s name</option>
              <option value="contact_method">
                A contact method&rsquo;s value
              </option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="redaction-target-id">
              {form.target === 'person' ? 'Person id' : 'Contact method id'}
            </label>
            <input
              id="redaction-target-id"
              type="text"
              value={form.targetId}
              onChange={(e) => setForm({ ...form, targetId: e.target.value })}
              required
            />
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="redaction-authority-kind">Authority</label>
            <select
              id="redaction-authority-kind"
              value={form.authorityKind}
              onChange={(e) =>
                setForm({
                  ...form,
                  authorityKind: e.target.value as RedactionAuthorityKind,
                })
              }
            >
              <option value="legal_requirement">Legal requirement</option>
              <option value="binding_policy">Binding policy</option>
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="redaction-authority-reference">
              Statute, policy, or order relied on
            </label>
            <input
              id="redaction-authority-reference"
              type="text"
              value={form.authorityReference}
              onChange={(e) =>
                setForm({ ...form, authorityReference: e.target.value })
              }
              required
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: '16px' }}>
          <label htmlFor="redaction-reason">Reason code</label>
          <input
            id="redaction-reason"
            type="text"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="resident_request"
            required
          />
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Redact permanently'}
          </button>
        </div>
      </form>

      <div className="panel-editor__title">Redactions</div>
      {compliance.length === 0 ? (
        <p className="muted panel-pad">Nothing has been redacted.</p>
      ) : (
        <div className="panel-list">
          {compliance.map((row) => (
            <ComplianceRow key={row.event_id} row={row} />
          ))}
        </div>
      )}

      <div className="panel-editor__title" style={{ marginTop: '26px' }}>
        Cleanup tasks
      </div>
      {tasks.length === 0 ? (
        <p className="muted panel-pad">No cleanup tasks.</p>
      ) : (
        <div className="panel-list">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              busy={busy}
              onCleanup={handleCleanup}
            />
          ))}
        </div>
      )}

      <div className="panel-editor__title" style={{ marginTop: '26px' }}>
        Access denials
      </div>
      <p className="admin-row-sub panel-pad">
        Privileged acts the ledger recorded as refused. Ordinary sign-in and
        permission failures are not recorded here, so an empty list does not
        mean nobody was ever turned away.
      </p>
      {data.denials.length === 0 ? (
        <p className="muted panel-pad">No privileged act has been refused.</p>
      ) : (
        <div className="panel-list">
          {data.denials.map((row) => (
            <DenialRow key={row.id} row={row} />
          ))}
        </div>
      )}

      <div className="panel-editor__title" style={{ marginTop: '26px' }}>
        Audit integrity
      </div>
      <p className="admin-row-sub panel-pad">
        Two operator-run checks. They are query shapes, never authorization
        boundaries: a row here is an anomaly to investigate, and never a reason
        to grant or deny anyone access.
      </p>
      {auditViolations.length === 0 &&
      boardEligibilityViolations.length === 0 ? (
        <p className="muted panel-pad">
          No integrity violations. An empty result is the expected, healthy
          state: the ledger reconstructs cleanly and every current board term
          still has its qualifying basis.
        </p>
      ) : (
        <>
          {auditViolations.length > 0 && (
            <div className="panel-list">
              {auditViolations.map((row) => (
                <div
                  className="list-row"
                  key={`${row.event_id}-${row.violation}`}
                >
                  <div className="admin-row-main">
                    <div className="admin-row-title">
                      Ledger &middot; {row.violation}
                    </div>
                    <div className="admin-row-sub">
                      {AUDIT_VIOLATION[row.violation] ?? row.violation}
                    </div>
                    <div className="admin-row-sub">Event {row.event_id}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {boardEligibilityViolations.length > 0 && (
            <div className="panel-list">
              {boardEligibilityViolations.map((row) => (
                <div
                  className="list-row"
                  key={`${row.board_term_id}-${row.violation}`}
                >
                  <div className="admin-row-main">
                    <div className="admin-row-title">
                      Board eligibility &middot; {row.violation}
                    </div>
                    <div className="admin-row-sub">
                      {BOARD_VIOLATION[row.violation] ?? row.violation}
                    </div>
                    <div className="admin-row-sub">
                      Term {row.board_term_id} &middot; person {row.person_id}
                      {row.qualifying_lot_id
                        ? ` · lot ${row.qualifying_lot_id}`
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="btn-row" style={{ marginTop: '26px' }}>
        <button
          className="btn btn--outline btn--small"
          disabled={busy}
          onClick={() => {
            setMsg('');
            void reload().catch(() => {});
          }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
