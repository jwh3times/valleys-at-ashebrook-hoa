import { useEffect, useState } from 'react';
import {
  fetchAccessGrants,
  fetchBoardService,
  fetchPersonLinks,
  fetchRoster,
  grantAccess,
  manualVerifyPersonLink,
  revokeAccess,
  unlinkPersonLink,
} from '../../lib/roster-admin';
import type {
  AccessGrantRow,
  BoardServiceTermRow,
  GrantType,
  IdentityEvidence,
  ManualVerifyReason,
  PersonLinkEndReason,
  PersonLinkRow,
  RosterPersonRow,
} from '../../lib/roster-admin';
import { useAdminResource } from './useAdminResource';

// ADR 0022 phase 3e (#221): the Access surface of the new model — the stored
// Access Grants authorization reads after the cutover, and the Person Links
// they hang off. Everything here goes through src/lib/roster-admin.ts; this
// panel never names a table and never fetches directly.

/** The two registers load together: ending a Person Link also ends every grant
 * it supported, so a write to either can change both. */
interface AccessRegisters {
  grants: AccessGrantRow[];
  links: PersonLinkRow[];
}

async function loadRegisters(): Promise<AccessRegisters> {
  const [grants, links] = await Promise.all([
    fetchAccessGrants(),
    fetchPersonLinks(),
  ]);
  return { grants, links };
}

const GRANT_TYPES: { value: GrantType; label: string }[] = [
  { value: 'board', label: 'Board access' },
  { value: 'system_admin', label: 'System administration' },
];

const MANUAL_VERIFY_REASONS: { value: ManualVerifyReason; label: string }[] = [
  { value: 'manual_board_decision', label: 'Manual board decision' },
  { value: 'migration_reverification', label: 'Migration re-verification' },
];

// `self_unlink` is deliberately absent from PersonLinkEndReason itself — it
// belongs to the applicant's own unlink route — so this list is simply every
// reason the type allows, and a typo here is a compile error.
const END_REASONS: { value: PersonLinkEndReason; label: string }[] = [
  { value: 'account_replaced', label: 'Account replaced' },
  { value: 'no_longer_qualifies', label: 'No longer qualifies' },
  { value: 'suspected_compromise', label: 'Suspected compromise' },
  { value: 'recorded_in_error', label: 'Recorded in error' },
  { value: 'resident_request', label: 'Resident request' },
];

/** Manual verification REQUIRES evidence, and each kind but observation
 * carries its own locator column — hence the per-kind label. */
const EVIDENCE_KINDS: {
  value: IdentityEvidence['kind'];
  label: string;
  locator: string | null;
}[] = [
  {
    value: 'operator_observation',
    label: 'Operator observation',
    locator: null,
  },
  { value: 'document', label: 'Document', locator: 'Document ID' },
  { value: 'meeting', label: 'Meeting', locator: 'Meeting ID' },
  { value: 'request', label: 'Request', locator: 'Request ID' },
  {
    value: 'external',
    label: 'External reference',
    locator: 'External reference',
  },
];

function buildEvidence(
  kind: IdentityEvidence['kind'],
  reference: string,
): IdentityEvidence | null {
  switch (kind) {
    case 'operator_observation':
      return { kind };
    case 'document':
      return reference ? { kind, documentId: reference } : null;
    case 'meeting':
      return reference ? { kind, meetingId: reference } : null;
    case 'request':
      return reference ? { kind, requestId: reference } : null;
    case 'external':
      return reference ? { kind, externalReference: reference } : null;
  }
}

/** These routes return epoch milliseconds, not the ISO strings the legacy
 * admin API returns. Rendered in the reader's local time. */
function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function termLabel(t: BoardServiceTermRow): string {
  const lot = t.qualifyingLotAddress ?? 'no qualifying lot';
  return `${t.personName} — ${lot} (${t.startDay} → ${t.scheduledEndDay})`;
}

const emptyGrantForm = {
  accountId: '',
  grantType: 'board' as GrantType,
  qualifyingBoardTermId: '',
};

const emptyVerifyForm = {
  accountId: '',
  personId: '',
  reason: 'manual_board_decision' as ManualVerifyReason,
  evidenceKind: '' as IdentityEvidence['kind'] | '',
  evidenceReference: '',
};

export default function AccessPanel() {
  const {
    data: registers,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<AccessRegisters>(loadRegisters, {
    grants: [],
    links: [],
  });

  const [grantForm, setGrantForm] = useState(emptyGrantForm);
  const [verifyForm, setVerifyForm] = useState(emptyVerifyForm);
  const [endReasons, setEndReasons] = useState<Record<string, string>>({});

  // Pickers. Both are loaded separately from the registers so that a failure
  // reading the roster or board service still leaves the registers — and
  // revoke/unlink — usable.
  const [terms, setTerms] = useState<BoardServiceTermRow[]>([]);
  const [people, setPeople] = useState<RosterPersonRow[]>([]);
  useEffect(() => {
    fetchBoardService()
      .then((detail) => setTerms(detail.terms))
      .catch(() => {});
    fetchRoster()
      .then((roster) => setPeople(roster.people))
      .catch(() => {});
  }, []);

  // A board grant hangs off a term that is still live or scheduled; an ended,
  // cancelled, or voided term cannot qualify one, and the route re-checks the
  // whole account → link → term chain anyway.
  const termOptions = terms.filter(
    (t) => !t.voided && t.cancelledDay === null && t.actualEndDay === null,
  );
  // Manual verification links an EXISTING Person and refuses a consolidated
  // one, so a consolidated party is never offered.
  const personOptions = people.filter(
    (p) => p.consolidatedIntoPartyId === null,
  );

  // Account ids are opaque, so the two registers double as the directory of
  // accounts the board has already seen — offered as suggestions, never as a
  // closed list (a brand-new account appears in neither).
  const knownAccounts = new Map<string, string>();
  for (const g of registers.grants) {
    if (!knownAccounts.has(g.accountId)) {
      knownAccounts.set(g.accountId, g.accountEmail ?? '');
    }
  }
  for (const l of registers.links) {
    if (!knownAccounts.has(l.accountId)) {
      knownAccounts.set(l.accountId, l.accountEmail ?? '');
    }
  }

  function submitGrant(e: React.FormEvent) {
    e.preventDefault();
    const accountId = grantForm.accountId.trim();
    if (!accountId) {
      setMsg('Error: Enter the account this grant is for.');
      return;
    }
    if (grantForm.grantType === 'board' && !grantForm.qualifyingBoardTermId) {
      setMsg('Error: Choose the board term that qualifies this grant.');
      return;
    }
    void run(async () => {
      await grantAccess(
        grantForm.grantType === 'board'
          ? {
              accountId,
              grantType: 'board',
              qualifyingBoardTermId: grantForm.qualifyingBoardTermId,
            }
          : // A system administration grant refuses a qualifying term, so the
            // key is omitted rather than sent empty.
            { accountId, grantType: 'system_admin' },
      );
      setGrantForm(emptyGrantForm);
      await reload();
    }, 'Access granted.');
  }

  function revoke(g: AccessGrantRow) {
    void run(async () => {
      await revokeAccess(g.id);
      await reload();
    }, 'Access revoked.');
  }

  function submitVerify(e: React.FormEvent) {
    e.preventDefault();
    const accountId = verifyForm.accountId.trim();
    if (!accountId) {
      setMsg('Error: Enter the account to link.');
      return;
    }
    if (!verifyForm.personId) {
      setMsg('Error: Choose the person this account belongs to.');
      return;
    }
    if (verifyForm.evidenceKind === '') {
      setMsg('Error: Evidence is required to record a manual verification.');
      return;
    }
    const evidence = buildEvidence(
      verifyForm.evidenceKind,
      verifyForm.evidenceReference.trim(),
    );
    if (!evidence) {
      setMsg('Error: Enter the reference for the evidence you chose.');
      return;
    }
    void run(async () => {
      await manualVerifyPersonLink({
        accountId,
        personId: verifyForm.personId,
        reason: verifyForm.reason,
        evidence,
      });
      setVerifyForm(emptyVerifyForm);
      await reload();
    }, 'Person link recorded.');
  }

  function unlink(l: PersonLinkRow) {
    const endReason = endReasons[l.id];
    if (!endReason) {
      setMsg('Error: Choose why this link is ending.');
      return;
    }
    void run(async () => {
      await unlinkPersonLink({
        linkId: l.id,
        endReason: endReason as PersonLinkEndReason,
      });
      setEndReasons({ ...endReasons, [l.id]: '' });
      await reload();
    }, 'Person link ended.');
  }

  /** A grant's term rendered as the picker renders it, falling back to the
   * bare id when the board-service read is unavailable. */
  function qualifyingTerm(termId: string): string {
    const term = terms.find((t) => t.id === termId);
    return term ? termLabel(term) : termId;
  }

  const evidenceLocator =
    EVIDENCE_KINDS.find((k) => k.value === verifyForm.evidenceKind)?.locator ??
    null;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Access</h1>
      </div>
      <p className="admin-panel__intro">
        Administers the new access model: the Access Grants that authorization
        reads once the cutover completes, and the Person Links each grant hangs
        off. Sign-in access before the cutover is still governed by the “Board
        access (legacy)” panel, which stays the surface to use until then.
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

      <div className="panel-editor__title">Access grants</div>
      <p className="admin-panel__intro">
        Board Access is never implicit — a grant is recorded here or it does not
        exist. A board grant names the board term that qualifies it; a system
        administration grant is taken by a System Administrator, and the last
        one cannot be revoked.
      </p>

      <form
        className="panel-card"
        onSubmit={submitGrant}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">Grant access</div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="grant-account">Account ID to grant</label>
            <input
              id="grant-account"
              type="text"
              list="access-accounts"
              value={grantForm.accountId}
              onChange={(e) =>
                setGrantForm({ ...grantForm, accountId: e.target.value })
              }
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="grant-type">Grant type</label>
            <select
              id="grant-type"
              value={grantForm.grantType}
              onChange={(e) =>
                setGrantForm({
                  ...grantForm,
                  grantType: e.target.value as GrantType,
                  qualifyingBoardTermId: '',
                })
              }
            >
              {GRANT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {grantForm.grantType === 'board' && (
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="grant-term">Qualifying board term</label>
            <select
              id="grant-term"
              value={grantForm.qualifyingBoardTermId}
              onChange={(e) =>
                setGrantForm({
                  ...grantForm,
                  qualifyingBoardTermId: e.target.value,
                })
              }
            >
              <option value="">— choose a term —</option>
              {termOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {termLabel(t)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Grant access'}
          </button>
        </div>
      </form>

      <datalist id="access-accounts">
        {[...knownAccounts].map(([id, email]) => (
          <option key={id} value={id}>
            {email}
          </option>
        ))}
      </datalist>

      <div className="panel-list" style={{ marginBottom: '30px' }}>
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : registers.grants.length === 0 ? (
          <p className="muted panel-pad">No access grants recorded.</p>
        ) : (
          registers.grants.map((g) => (
            <div key={g.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">
                  {g.accountEmail ?? g.accountId} —{' '}
                  {GRANT_TYPES.find((t) => t.value === g.grantType)?.label ??
                    g.grantType}
                  {g.live ? ' · Live' : ' · Ended'}
                </div>
                <div className="admin-row-sub">
                  Started {formatMs(g.startedAt)}
                  {g.grantReason ? ` (${g.grantReason})` : ''}
                  {g.live
                    ? ''
                    : ` · Ended ${formatMs(g.endedAt)}${
                        g.endReason ? ` (${g.endReason})` : ''
                      }`}
                </div>
                <div className="admin-row-sub">
                  {g.qualifyingBoardTermId
                    ? `Qualifying term: ${qualifyingTerm(g.qualifyingBoardTermId)}`
                    : 'No qualifying term'}
                </div>
              </div>
              {g.live && (
                <div className="row-actions">
                  <button
                    className="row-link row-link--danger"
                    aria-label={`Revoke ${g.grantType} grant for ${
                      g.accountEmail ?? g.accountId
                    }`}
                    onClick={() => revoke(g)}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="panel-editor__title">Person links</div>
      <p className="admin-panel__intro">
        Which account belongs to which person, and how that was proved. Manual
        verification links an existing person — it never creates one — and
        unlinking also ends every access grant the link supported.
      </p>

      <form
        className="panel-card"
        onSubmit={submitVerify}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">Verify by hand</div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="verify-account">Account ID to link</label>
            <input
              id="verify-account"
              type="text"
              list="access-accounts"
              value={verifyForm.accountId}
              onChange={(e) =>
                setVerifyForm({ ...verifyForm, accountId: e.target.value })
              }
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="verify-person">Person</label>
            <select
              id="verify-person"
              value={verifyForm.personId}
              onChange={(e) =>
                setVerifyForm({ ...verifyForm, personId: e.target.value })
              }
            >
              <option value="">— choose a person —</option>
              {personOptions.map((p) => (
                <option key={p.partyId} value={p.partyId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="verify-reason">Reason</label>
            <select
              id="verify-reason"
              value={verifyForm.reason}
              onChange={(e) =>
                setVerifyForm({
                  ...verifyForm,
                  reason: e.target.value as ManualVerifyReason,
                })
              }
            >
              {MANUAL_VERIFY_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="verify-evidence">Evidence (required)</label>
            <select
              id="verify-evidence"
              value={verifyForm.evidenceKind}
              onChange={(e) =>
                setVerifyForm({
                  ...verifyForm,
                  evidenceKind: e.target.value as IdentityEvidence['kind'] | '',
                  evidenceReference: '',
                })
              }
            >
              <option value="">— choose evidence —</option>
              {EVIDENCE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {evidenceLocator && (
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="verify-evidence-ref">{evidenceLocator}</label>
            <input
              id="verify-evidence-ref"
              type="text"
              value={verifyForm.evidenceReference}
              onChange={(e) =>
                setVerifyForm({
                  ...verifyForm,
                  evidenceReference: e.target.value,
                })
              }
            />
          </div>
        )}
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Record person link'}
          </button>
        </div>
      </form>

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : registers.links.length === 0 ? (
          <p className="muted panel-pad">No person links recorded.</p>
        ) : (
          registers.links.map((l) => (
            <div key={l.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">
                  {l.accountEmail ?? l.accountName ?? l.accountId} —{' '}
                  {l.personDisplayName}
                  {l.current ? ' · Current' : ' · Ended'}
                </div>
                <div className="admin-row-sub">
                  Verified by {l.verification.method}
                  {l.verification.reason
                    ? ` (${l.verification.reason})`
                    : ''}{' '}
                  on {formatMs(l.verification.verifiedAt)}
                </div>
                <div className="admin-row-sub">
                  Linked {formatMs(l.startedAt)}
                  {l.current
                    ? ''
                    : ` · Ended ${formatMs(l.endedAt)}${
                        l.endReason ? ` (${l.endReason})` : ''
                      }`}
                </div>
                {l.current && (
                  <>
                    <label htmlFor={`end-reason-${l.id}`} className="sr-only">
                      {`End reason for ${l.accountEmail ?? l.accountId}`}
                    </label>
                    <select
                      id={`end-reason-${l.id}`}
                      value={endReasons[l.id] ?? ''}
                      onChange={(e) =>
                        setEndReasons({
                          ...endReasons,
                          [l.id]: e.target.value,
                        })
                      }
                    >
                      <option value="">— end reason —</option>
                      {END_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              {l.current && (
                <div className="row-actions">
                  <button
                    className="row-link row-link--danger"
                    aria-label={`Unlink ${l.accountEmail ?? l.accountId}`}
                    onClick={() => unlink(l)}
                  >
                    Unlink
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
