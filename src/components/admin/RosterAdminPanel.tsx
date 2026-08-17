import { useState } from 'react';
import {
  addContactMethod,
  consolidateParties,
  correctConsolidation,
  correctLotRetirement,
  correctOrganizationName,
  correctPersonName,
  correctRepresentationScope,
  createOrganization,
  createOwnership,
  createPerson,
  createRepresentation,
  endContactMethod,
  endOwnership,
  endRepresentation,
  exportRoster,
  fetchRoster,
  retireLot,
  setPreferredContactMethod,
  voidContactMethod,
  voidOwnership,
  voidRepresentation,
} from '../../lib/roster-admin';
import type {
  AdminRoster,
  BasicEvidence,
  ContactChannel,
  RepresentationScopeInput,
  RepresentationScopeKind,
  RosterEvidence,
  RosterExport,
  TermSubstitution,
} from '../../lib/roster-admin';
import { associationDateIso, formatDate } from '../../lib/format';
import { useAdminResource } from './useAdminResource';

// ADR 0022 phase 3e (#221): the writable Roster surface — Lots, Parties,
// Ownerships, Representations and Contact Methods, over the phase 3b routes.
//
// Two rules this panel exists to honor:
//
//  - Display names arrive already rendered (a real name, or the durable-ID
//    redaction fallback). They are shown exactly as given and NEVER
//    re-derived here — a privileged variant would defeat redaction.
//  - Every refusal these routes raise is a sentence the board needs to read
//    ("A current board term names this lot as its qualifying lot…"), so the
//    server's plain text is surfaced verbatim through `run()`.

const EMPTY_ROSTER: AdminRoster = {
  lots: [],
  people: [],
  organizations: [],
  ownerships: [],
  representations: [],
  contactMethods: [],
  advisories: { ownerlessLotIds: [] },
};

const SECTIONS = [
  { value: 'lots', label: 'Lots' },
  { value: 'parties', label: 'Parties' },
  { value: 'ownerships', label: 'Ownerships' },
  { value: 'representations', label: 'Representations' },
  { value: 'contacts', label: 'Contact methods' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['value'];

// The export is a recorded act, not a read: the wording states both
// consequences before the board commits to it.
const EXPORT_CONFIRM =
  'Export the full roster?\n\n' +
  'This export is permanently recorded as an Access Event, and it removes ' +
  'personal data from the system’s control.\n\n' +
  'Continue?';

// ---------------------------------------------------------------------------
// Evidence — a minimal locator, not an evidence builder
// ---------------------------------------------------------------------------
// Each route accepts its own subset of kinds, so the offered set is passed in
// rather than shared: a panel must never offer a kind its route would 400.

type EvidenceKind =
  | 'none'
  | 'operator_observation'
  | 'document'
  | 'external'
  | 'meeting'
  | 'election'
  | 'request';

interface EvidenceState {
  kind: EvidenceKind;
  reference: string;
}

const NO_EVIDENCE: EvidenceState = { kind: 'none', reference: '' };

const BASIC_KINDS: EvidenceKind[] = [
  'none',
  'operator_observation',
  'document',
  'external',
];

const ROSTER_KINDS: EvidenceKind[] = [
  ...BASIC_KINDS,
  'meeting',
  'election',
  'request',
];

const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  none: '— none —',
  operator_observation: 'Operator observation',
  document: 'Document',
  external: 'External reference',
  meeting: 'Meeting',
  election: 'Election',
  request: 'Request',
};

const REFERENCE_LABELS: Partial<Record<EvidenceKind, string>> = {
  document: 'Document ID',
  external: 'External reference',
  meeting: 'Meeting ID',
  election: 'Election ID',
  request: 'Request ID',
};

function buildEvidence(state: EvidenceState): RosterEvidence | undefined {
  const reference = state.reference.trim();
  switch (state.kind) {
    case 'none':
      return undefined;
    case 'operator_observation':
      return { kind: 'operator_observation' };
    case 'document':
      return { kind: 'document', documentId: reference };
    case 'external':
      return { kind: 'external', externalReference: reference };
    case 'meeting':
      return { kind: 'meeting', meetingId: reference };
    case 'election':
      return { kind: 'election', electionId: reference };
    case 'request':
      return { kind: 'request', requestId: reference };
  }
}

function buildBasicEvidence(state: EvidenceState): BasicEvidence | undefined {
  const evidence = buildEvidence(state);
  if (!evidence) return undefined;
  return evidence.kind === 'operator_observation' ||
    evidence.kind === 'document' ||
    evidence.kind === 'external'
    ? evidence
    : undefined;
}

function EvidenceFields({
  idPrefix,
  kinds,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  kinds: EvidenceKind[];
  value: EvidenceState;
  onChange: (next: EvidenceState) => void;
  disabled?: boolean;
}) {
  const referenceLabel = REFERENCE_LABELS[value.kind];
  return (
    <div className="field-grid" style={{ marginBottom: '16px' }}>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`${idPrefix}-evidence-kind`}>Evidence (optional)</label>
        <select
          id={`${idPrefix}-evidence-kind`}
          value={value.kind}
          onChange={(e) =>
            onChange({ kind: e.target.value as EvidenceKind, reference: '' })
          }
          disabled={disabled}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {EVIDENCE_LABELS[kind]}
            </option>
          ))}
        </select>
      </div>
      {referenceLabel && (
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor={`${idPrefix}-evidence-ref`}>{referenceLabel}</label>
          <input
            id={`${idPrefix}-evidence-ref`}
            type="text"
            value={value.reference}
            onChange={(e) => onChange({ ...value, reference: e.target.value })}
            required
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Substitutions — the escape from terminate-by-default
// ---------------------------------------------------------------------------

interface SubstitutionDraft {
  termId: string;
  qualifyingLotId: string;
}

function buildSubstitutions(
  rows: SubstitutionDraft[],
): TermSubstitution[] | undefined {
  const filled = rows.filter(
    (row) => row.termId.trim() !== '' && row.qualifyingLotId !== '',
  );
  return filled.length === 0
    ? undefined
    : filled.map((row) => ({
        termId: row.termId.trim(),
        qualifyingLotId: row.qualifyingLotId,
      }));
}

function SubstitutionEditor({
  idPrefix,
  rows,
  lots,
  onChange,
  disabled,
}: {
  idPrefix: string;
  rows: SubstitutionDraft[];
  lots: { id: string; label: string }[];
  onChange: (next: SubstitutionDraft[]) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div className="field-label">Board term substitutions (optional)</div>
      <p className="muted" style={{ marginTop: 0 }}>
        Any board term this ending affects that is not listed here{' '}
        <strong>terminates by default</strong>. Term IDs come from the Board
        panel.
      </p>
      {rows.map((row, index) => (
        <div
          key={index}
          className="field-grid"
          style={{ marginBottom: '10px' }}
        >
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`${idPrefix}-sub-term-${index}`}>Term ID</label>
            <input
              id={`${idPrefix}-sub-term-${index}`}
              type="text"
              value={row.termId}
              onChange={(e) =>
                onChange(
                  rows.map((existing, i) =>
                    i === index
                      ? { ...existing, termId: e.target.value }
                      : existing,
                  ),
                )
              }
              disabled={disabled}
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`${idPrefix}-sub-lot-${index}`}>
              Replacement qualifying lot
            </label>
            <select
              id={`${idPrefix}-sub-lot-${index}`}
              value={row.qualifyingLotId}
              onChange={(e) =>
                onChange(
                  rows.map((existing, i) =>
                    i === index
                      ? { ...existing, qualifyingLotId: e.target.value }
                      : existing,
                  ),
                )
              }
              disabled={disabled}
            >
              <option value="">— choose a lot —</option>
              {lots.map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <div className="btn-row">
        <button
          className="btn btn--small btn--outline"
          type="button"
          onClick={() =>
            onChange([...rows, { termId: '', qualifyingLotId: '' }])
          }
          disabled={disabled}
        >
          Add substitution
        </button>
        {rows.length > 0 && (
          <button
            className="btn btn--small btn--outline"
            type="button"
            onClick={() => onChange(rows.slice(0, -1))}
            disabled={disabled}
          >
            Remove last
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function dayText(day: string | null): string {
  return day ? formatDate(day) : '—';
}

/** New-model timestamps are epoch milliseconds, not ISO strings. */
function stampText(ms: number | null): string {
  return ms === null ? '—' : formatDate(associationDateIso(new Date(ms)));
}

function downloadJson(data: RosterExport) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `roster-export-${associationDateIso(new Date(data.generatedAt))}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function RosterAdminPanel() {
  const {
    data: roster,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<AdminRoster>(fetchRoster, EMPTY_ROSTER);

  const [section, setSection] = useState<SectionKey>('lots');

  // Lots
  const [retireForm, setRetireForm] = useState({ lotId: '', effectiveDay: '' });
  const [retireEvidence, setRetireEvidence] =
    useState<EvidenceState>(NO_EVIDENCE);

  // Parties
  const [personName, setPersonName] = useState('');
  const [personEvidence, setPersonEvidence] =
    useState<EvidenceState>(NO_EVIDENCE);
  const [orgForm, setOrgForm] = useState({ legalName: '', displayName: '' });
  const [orgEvidence, setOrgEvidence] = useState<EvidenceState>(NO_EVIDENCE);
  const [nameEdit, setNameEdit] = useState<{
    partyId: string;
    kind: 'person' | 'organization';
    fullName: string;
    legalName: string;
    displayName: string;
  } | null>(null);
  const [nameEvidence, setNameEvidence] = useState<EvidenceState>(NO_EVIDENCE);
  const [consolidation, setConsolidation] = useState({
    duplicatePartyId: '',
    survivorPartyId: '',
  });
  const [consolidateEvidence, setConsolidateEvidence] =
    useState<EvidenceState>(NO_EVIDENCE);
  const [consolidateReview, setConsolidateReview] = useState(false);

  // Ownerships
  const [ownershipForm, setOwnershipForm] = useState({
    ownerPartyId: '',
    lotId: '',
    startDay: '',
  });
  const [ownershipEvidence, setOwnershipEvidence] =
    useState<EvidenceState>(NO_EVIDENCE);
  const [endingOwnershipId, setEndingOwnershipId] = useState<string | null>(
    null,
  );
  const [ownershipEndDay, setOwnershipEndDay] = useState('');
  const [ownershipEndEvidence, setOwnershipEndEvidence] =
    useState<EvidenceState>(NO_EVIDENCE);
  const [ownershipSubs, setOwnershipSubs] = useState<SubstitutionDraft[]>([]);

  // Representations
  const [repForm, setRepForm] = useState({
    representativePersonId: '',
    organizationPartyId: '',
    startDay: '',
    endDay: '',
    scopeKind: 'organization' as RepresentationScopeKind,
    lotIds: [] as string[],
  });
  const [repEvidence, setRepEvidence] = useState<EvidenceState>(NO_EVIDENCE);
  const [endingRepId, setEndingRepId] = useState<string | null>(null);
  const [repEndDay, setRepEndDay] = useState('');
  const [repEndEvidence, setRepEndEvidence] =
    useState<EvidenceState>(NO_EVIDENCE);
  const [repEndSubs, setRepEndSubs] = useState<SubstitutionDraft[]>([]);
  const [scopeEditId, setScopeEditId] = useState<string | null>(null);
  const [scopeEdit, setScopeEdit] = useState({
    scopeKind: 'organization' as RepresentationScopeKind,
    lotIds: [] as string[],
  });

  // Contact methods
  const [contactFilter, setContactFilter] = useState('');
  const [contactForm, setContactForm] = useState({
    partyId: '',
    channel: 'email' as ContactChannel,
    value: '',
    startDay: '',
    isPreferred: false,
  });
  const [endingContactId, setEndingContactId] = useState<string | null>(null);
  const [contactEndDay, setContactEndDay] = useState('');

  const lotOptions = roster.lots.map((lot) => ({
    id: lot.id,
    label: lot.unit ? `${lot.address} ${lot.unit}` : lot.address,
  }));
  const lotLabels = new Map(lotOptions.map((lot) => [lot.id, lot.label]));
  function lotLabel(id: string | null): string {
    if (!id) return '—';
    return lotLabels.get(id) ?? id;
  }

  // Display names are used exactly as the route rendered them.
  const partyLabels = new Map<string, string>();
  for (const person of roster.people)
    partyLabels.set(person.partyId, person.displayName);
  for (const org of roster.organizations)
    partyLabels.set(org.partyId, org.displayName ?? org.legalName);
  function partyLabel(id: string): string {
    return partyLabels.get(id) ?? id;
  }

  const partyOptions = [
    ...roster.people.map((person) => ({
      id: person.partyId,
      label: person.displayName,
    })),
    ...roster.organizations.map((org) => ({
      id: org.partyId,
      label: org.displayName ?? org.legalName,
    })),
  ];

  const ownerlessLotIds = roster.advisories.ownerlessLotIds;

  // ---- Lots ---------------------------------------------------------------

  function submitRetire(e: React.FormEvent) {
    e.preventDefault();
    const effectiveDay = retireForm.effectiveDay.trim();
    void run(async () => {
      await retireLot({
        lotId: retireForm.lotId,
        effectiveDay: effectiveDay === '' ? undefined : effectiveDay,
        evidence: buildBasicEvidence(retireEvidence),
      });
      setRetireForm({ lotId: '', effectiveDay: '' });
      setRetireEvidence(NO_EVIDENCE);
      await reload();
    }, 'Lot retired.');
  }

  function undoRetirement(lotId: string) {
    void run(async () => {
      await correctLotRetirement(lotId);
      await reload();
    }, 'Retirement corrected. Ownerships are not restored.');
  }

  // ---- Parties ------------------------------------------------------------

  function submitPerson(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      await createPerson({
        fullName: personName.trim(),
        evidence: buildBasicEvidence(personEvidence),
      });
      setPersonName('');
      setPersonEvidence(NO_EVIDENCE);
      await reload();
    }, 'Person recorded.');
  }

  function submitOrganization(e: React.FormEvent) {
    e.preventDefault();
    const displayName = orgForm.displayName.trim();
    // A normalized-name collision is a WARNING on a successful create, not a
    // refusal, so it has to be read off the response rather than the error.
    let warning = '';
    void run(async () => {
      const created = await createOrganization({
        legalName: orgForm.legalName.trim(),
        displayName: displayName === '' ? undefined : displayName,
        evidence: buildBasicEvidence(orgEvidence),
      });
      warning = created.warning ?? '';
      setOrgForm({ legalName: '', displayName: '' });
      setOrgEvidence(NO_EVIDENCE);
      await reload();
    }, 'Organization recorded.').then(() => {
      if (warning) setMsg(`Organization recorded. ${warning}`);
    });
  }

  function submitNameCorrection(e: React.FormEvent) {
    e.preventDefault();
    const edit = nameEdit;
    if (!edit) return;
    void run(async () => {
      if (edit.kind === 'person') {
        await correctPersonName({
          personId: edit.partyId,
          fullName: edit.fullName.trim(),
          evidence: buildBasicEvidence(nameEvidence),
        });
      } else {
        const displayName = edit.displayName.trim();
        await correctOrganizationName(edit.partyId, {
          legalName: edit.legalName.trim(),
          // Blank clears the display name; the route decides by key presence.
          displayName: displayName === '' ? null : displayName,
        });
      }
      setNameEdit(null);
      setNameEvidence(NO_EVIDENCE);
      await reload();
    }, 'Name corrected.');
  }

  function confirmConsolidation() {
    void run(async () => {
      await consolidateParties({
        duplicatePartyId: consolidation.duplicatePartyId,
        survivorPartyId: consolidation.survivorPartyId,
        evidence: buildBasicEvidence(consolidateEvidence),
      });
      setConsolidation({ duplicatePartyId: '', survivorPartyId: '' });
      setConsolidateEvidence(NO_EVIDENCE);
      setConsolidateReview(false);
      await reload();
    }, 'Parties consolidated.');
  }

  function undoConsolidation(duplicatePartyId: string) {
    void run(async () => {
      await correctConsolidation(duplicatePartyId);
      await reload();
    }, 'Consolidation corrected.');
  }

  // ---- Ownerships ---------------------------------------------------------

  function submitOwnership(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      await createOwnership({
        ownerPartyId: ownershipForm.ownerPartyId,
        lotId: ownershipForm.lotId,
        startDay: ownershipForm.startDay,
        evidence: buildEvidence(ownershipEvidence),
      });
      setOwnershipForm({ ownerPartyId: '', lotId: '', startDay: '' });
      setOwnershipEvidence(NO_EVIDENCE);
      await reload();
    }, 'Ownership recorded.');
  }

  function submitOwnershipEnd(e: React.FormEvent) {
    e.preventDefault();
    const ownershipId = endingOwnershipId;
    if (!ownershipId) return;
    void run(async () => {
      await endOwnership({
        ownershipId,
        endDay: ownershipEndDay,
        substitutions: buildSubstitutions(ownershipSubs),
        evidence: buildEvidence(ownershipEndEvidence),
      });
      setEndingOwnershipId(null);
      setOwnershipEndDay('');
      setOwnershipSubs([]);
      setOwnershipEndEvidence(NO_EVIDENCE);
      await reload();
    }, 'Ownership ended.');
  }

  function removeOwnership(ownershipId: string) {
    void run(async () => {
      await voidOwnership(ownershipId);
      await reload();
    }, 'Ownership voided.');
  }

  // ---- Representations ----------------------------------------------------

  function submitRepresentation(e: React.FormEvent) {
    e.preventDefault();
    const endDay = repForm.endDay.trim();
    void run(async () => {
      const base = {
        representativePersonId: repForm.representativePersonId,
        organizationPartyId: repForm.organizationPartyId,
        startDay: repForm.startDay,
        endDay: endDay === '' ? undefined : endDay,
        evidence: buildEvidence(repEvidence),
      };
      await createRepresentation(
        repForm.scopeKind === 'organization'
          ? { ...base, scopeKind: 'organization' }
          : { ...base, scopeKind: 'lots', lotIds: repForm.lotIds },
      );
      setRepForm({
        representativePersonId: '',
        organizationPartyId: '',
        startDay: '',
        endDay: '',
        scopeKind: 'organization',
        lotIds: [],
      });
      setRepEvidence(NO_EVIDENCE);
      await reload();
    }, 'Representation recorded.');
  }

  function submitRepresentationEnd(e: React.FormEvent) {
    e.preventDefault();
    const representationId = endingRepId;
    if (!representationId) return;
    const endDay = repEndDay.trim();
    void run(async () => {
      await endRepresentation({
        representationId,
        endDay: endDay === '' ? undefined : endDay,
        substitutions: buildSubstitutions(repEndSubs),
        evidence: buildEvidence(repEndEvidence),
      });
      setEndingRepId(null);
      setRepEndDay('');
      setRepEndSubs([]);
      setRepEndEvidence(NO_EVIDENCE);
      await reload();
    }, 'Representation ended.');
  }

  function removeRepresentation(representationId: string) {
    void run(async () => {
      await voidRepresentation(representationId);
      await reload();
    }, 'Representation voided.');
  }

  function submitScopeCorrection(e: React.FormEvent) {
    e.preventDefault();
    const representationId = scopeEditId;
    if (!representationId) return;
    const scope: RepresentationScopeInput =
      scopeEdit.scopeKind === 'organization'
        ? { scopeKind: 'organization' }
        : { scopeKind: 'lots', lotIds: scopeEdit.lotIds };
    void run(async () => {
      await correctRepresentationScope(representationId, scope);
      setScopeEditId(null);
      await reload();
    }, 'Scope corrected.');
  }

  // ---- Contact methods ----------------------------------------------------

  function submitContact(e: React.FormEvent) {
    e.preventDefault();
    const startDay = contactForm.startDay.trim();
    void run(async () => {
      await addContactMethod({
        partyId: contactForm.partyId,
        channel: contactForm.channel,
        value: contactForm.value.trim(),
        startDay: startDay === '' ? undefined : startDay,
        isPreferred: contactForm.isPreferred,
      });
      setContactForm({
        partyId: contactForm.partyId,
        channel: 'email',
        value: '',
        startDay: '',
        isPreferred: false,
      });
      await reload();
    }, 'Contact method added.');
  }

  function submitContactEnd(e: React.FormEvent) {
    e.preventDefault();
    const contactMethodId = endingContactId;
    if (!contactMethodId) return;
    const endDay = contactEndDay.trim();
    void run(async () => {
      await endContactMethod({
        contactMethodId,
        endDay: endDay === '' ? undefined : endDay,
      });
      setEndingContactId(null);
      setContactEndDay('');
      await reload();
    }, 'Contact method ended.');
  }

  function removeContact(contactMethodId: string) {
    void run(async () => {
      await voidContactMethod(contactMethodId);
      await reload();
    }, 'Contact method voided.');
  }

  function preferContact(contactMethodId: string) {
    void run(async () => {
      await setPreferredContactMethod(contactMethodId);
      await reload();
    }, 'Preferred contact method set.');
  }

  // ---- Export -------------------------------------------------------------

  function exportNow() {
    // confirm() BEFORE run() — run() flips `busy`, and a dialog inside it
    // would hold the panel busy while the prompt sits open.
    if (!window.confirm(EXPORT_CONFIRM)) return;
    void run(async () => {
      const data = await exportRoster();
      downloadJson(data);
    }, 'Roster exported. The export is recorded as an Access Event.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Roster</h1>
        <button
          className="btn btn--small btn--outline"
          type="button"
          onClick={exportNow}
          disabled={busy}
        >
          Export roster
        </button>
      </div>
      <p className="admin-panel__intro">
        The durable roster: lots, parties, ownerships, representations and
        contact methods. Every change here is recorded in the audit ledger, and
        corrections are recorded rather than erasing what was there.
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

      {ownerlessLotIds.length > 0 && (
        <div
          className="panel-card"
          role="status"
          style={{ marginBottom: '22px' }}
        >
          <div className="panel-editor__title">
            Ownerless lots ({ownerlessLotIds.length})
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            These lots are not retired and have no current ownership recorded.
          </p>
          <ul style={{ margin: 0, paddingLeft: '20px' }}>
            {ownerlessLotIds.map((id) => (
              <li key={id}>{lotLabel(id)}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        role="group"
        aria-label="Roster sections"
        style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '18px',
        }}
      >
        {SECTIONS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className={`btn btn--small${section === entry.value ? '' : ' btn--outline'}`}
            aria-pressed={section === entry.value}
            onClick={() => setSection(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="loading panel-pad">Loading…</p>
      ) : (
        <>
          {/* ---- Lots ---------------------------------------------------- */}
          {section === 'lots' && (
            <>
              <form
                className="panel-card"
                onSubmit={submitRetire}
                style={{ marginBottom: '26px' }}
              >
                <div className="panel-editor__title">Retire a lot</div>
                <p className="muted" style={{ marginTop: 0 }}>
                  Retiring ends the lot’s current ownerships. It is refused
                  while a current board term names the lot as its qualifying
                  lot, or while an open occasion has frozen its eligibility.
                </p>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="retire-lot">Lot</label>
                    <select
                      id="retire-lot"
                      value={retireForm.lotId}
                      onChange={(e) =>
                        setRetireForm({ ...retireForm, lotId: e.target.value })
                      }
                      required
                      disabled={busy}
                    >
                      <option value="">— choose a lot —</option>
                      {roster.lots
                        .filter((lot) => lot.retiredDay === null)
                        .map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lotLabel(lot.id)}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="retire-day">
                      Effective day (defaults to today)
                    </label>
                    <input
                      id="retire-day"
                      type="date"
                      value={retireForm.effectiveDay}
                      onChange={(e) =>
                        setRetireForm({
                          ...retireForm,
                          effectiveDay: e.target.value,
                        })
                      }
                      disabled={busy}
                    />
                  </div>
                </div>
                <EvidenceFields
                  idPrefix="retire"
                  kinds={BASIC_KINDS}
                  value={retireEvidence}
                  onChange={setRetireEvidence}
                  disabled={busy}
                />
                <div className="btn-row">
                  <button
                    className="btn btn--small"
                    type="submit"
                    disabled={busy}
                  >
                    {busy ? 'Saving…' : 'Retire lot'}
                  </button>
                </div>
              </form>

              <div className="panel-list">
                {roster.lots.length === 0 ? (
                  <p className="muted panel-pad">No lots recorded yet.</p>
                ) : (
                  roster.lots.map((lot) => (
                    <div
                      key={lot.id}
                      className="panel-card"
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="list-row">
                        <div className="admin-row-main">
                          <div className="admin-row-title">
                            {lotLabel(lot.id)}
                            {lot.ownerless ? ' — ownerless' : ''}
                          </div>
                          <div className="admin-row-sub">
                            Vote weight {lot.voteWeight} ·{' '}
                            {lot.retiredDay
                              ? `Retired ${dayText(lot.retiredDay)} (recorded ${stampText(lot.retiredAt)})`
                              : 'Active'}
                          </div>
                        </div>
                        {lot.retiredDay && (
                          <div className="row-actions">
                            <button
                              className="row-link"
                              type="button"
                              aria-label={`Correct retirement of ${lotLabel(lot.id)}`}
                              onClick={() => undoRetirement(lot.id)}
                              disabled={busy}
                            >
                              Correct retirement
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* ---- Parties ------------------------------------------------- */}
          {section === 'parties' && (
            <>
              <form
                className="panel-card"
                onSubmit={submitPerson}
                style={{ marginBottom: '20px' }}
              >
                <div className="panel-editor__title">Add a person</div>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="person-name">Full name</label>
                    <input
                      id="person-name"
                      type="text"
                      value={personName}
                      onChange={(e) => setPersonName(e.target.value)}
                      required
                      disabled={busy}
                    />
                  </div>
                </div>
                <EvidenceFields
                  idPrefix="person"
                  kinds={BASIC_KINDS}
                  value={personEvidence}
                  onChange={setPersonEvidence}
                  disabled={busy}
                />
                <div className="btn-row">
                  <button
                    className="btn btn--small"
                    type="submit"
                    disabled={busy}
                  >
                    Add person
                  </button>
                </div>
              </form>

              <form
                className="panel-card"
                onSubmit={submitOrganization}
                style={{ marginBottom: '20px' }}
              >
                <div className="panel-editor__title">Add an organization</div>
                <p className="muted" style={{ marginTop: 0 }}>
                  Organization names are not unique. A name that matches an
                  existing organization is recorded with a warning, never
                  merged.
                </p>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="org-legal-name">Legal name</label>
                    <input
                      id="org-legal-name"
                      type="text"
                      value={orgForm.legalName}
                      onChange={(e) =>
                        setOrgForm({ ...orgForm, legalName: e.target.value })
                      }
                      required
                      disabled={busy}
                    />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="org-display-name">
                      Display name (optional)
                    </label>
                    <input
                      id="org-display-name"
                      type="text"
                      value={orgForm.displayName}
                      onChange={(e) =>
                        setOrgForm({ ...orgForm, displayName: e.target.value })
                      }
                      disabled={busy}
                    />
                  </div>
                </div>
                <EvidenceFields
                  idPrefix="org"
                  kinds={BASIC_KINDS}
                  value={orgEvidence}
                  onChange={setOrgEvidence}
                  disabled={busy}
                />
                <div className="btn-row">
                  <button
                    className="btn btn--small"
                    type="submit"
                    disabled={busy}
                  >
                    Add organization
                  </button>
                </div>
              </form>

              <div className="panel-card" style={{ marginBottom: '26px' }}>
                <div className="panel-editor__title">
                  Consolidate duplicates
                </div>
                <p className="muted" style={{ marginTop: 0 }}>
                  Choose the duplicate and, separately, the party that survives.
                  The survivor is never chosen for you. Consolidation is a
                  one-hop pointer between two parties of the same kind, and is
                  refused when both are already linked to accounts.
                </p>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="consolidate-duplicate">
                      Duplicate party
                    </label>
                    <select
                      id="consolidate-duplicate"
                      value={consolidation.duplicatePartyId}
                      onChange={(e) => {
                        setConsolidateReview(false);
                        setConsolidation({
                          ...consolidation,
                          duplicatePartyId: e.target.value,
                        });
                      }}
                      disabled={busy}
                    >
                      <option value="">— choose the duplicate —</option>
                      {partyOptions.map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="consolidate-survivor">
                      Surviving party
                    </label>
                    <select
                      id="consolidate-survivor"
                      value={consolidation.survivorPartyId}
                      onChange={(e) => {
                        setConsolidateReview(false);
                        setConsolidation({
                          ...consolidation,
                          survivorPartyId: e.target.value,
                        });
                      }}
                      disabled={busy}
                    >
                      <option value="">— choose the survivor —</option>
                      {partyOptions
                        .filter(
                          (party) =>
                            party.id !== consolidation.duplicatePartyId,
                        )
                        .map((party) => (
                          <option key={party.id} value={party.id}>
                            {party.label}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                <EvidenceFields
                  idPrefix="consolidate"
                  kinds={BASIC_KINDS}
                  value={consolidateEvidence}
                  onChange={setConsolidateEvidence}
                  disabled={busy}
                />
                {consolidateReview ? (
                  <div role="status" style={{ marginBottom: '14px' }}>
                    <p style={{ marginTop: 0 }}>
                      <strong>
                        {partyLabel(consolidation.duplicatePartyId)}
                      </strong>{' '}
                      will be consolidated into{' '}
                      <strong>
                        {partyLabel(consolidation.survivorPartyId)}
                      </strong>
                      .
                    </p>
                    <div className="btn-row">
                      <button
                        className="btn btn--small"
                        type="button"
                        onClick={confirmConsolidation}
                        disabled={busy}
                      >
                        Confirm consolidation
                      </button>
                      <button
                        className="btn btn--small btn--outline"
                        type="button"
                        onClick={() => setConsolidateReview(false)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="btn-row">
                    <button
                      className="btn btn--small"
                      type="button"
                      onClick={() => setConsolidateReview(true)}
                      disabled={
                        busy ||
                        consolidation.duplicatePartyId === '' ||
                        consolidation.survivorPartyId === ''
                      }
                    >
                      Review consolidation
                    </button>
                  </div>
                )}
              </div>

              {nameEdit && (
                <form
                  className="panel-card"
                  onSubmit={submitNameCorrection}
                  style={{ marginBottom: '20px' }}
                >
                  <div className="panel-editor__title">Correct a name</div>
                  <div className="field-grid" style={{ marginBottom: '16px' }}>
                    {nameEdit.kind === 'person' ? (
                      <div className="field" style={{ margin: 0 }}>
                        <label htmlFor="correct-person-name">Full name</label>
                        <input
                          id="correct-person-name"
                          type="text"
                          value={nameEdit.fullName}
                          onChange={(e) =>
                            setNameEdit({
                              ...nameEdit,
                              fullName: e.target.value,
                            })
                          }
                          required
                          disabled={busy}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="field" style={{ margin: 0 }}>
                          <label htmlFor="correct-org-legal">Legal name</label>
                          <input
                            id="correct-org-legal"
                            type="text"
                            value={nameEdit.legalName}
                            onChange={(e) =>
                              setNameEdit({
                                ...nameEdit,
                                legalName: e.target.value,
                              })
                            }
                            required
                            disabled={busy}
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label htmlFor="correct-org-display">
                            Display name (blank clears it)
                          </label>
                          <input
                            id="correct-org-display"
                            type="text"
                            value={nameEdit.displayName}
                            onChange={(e) =>
                              setNameEdit({
                                ...nameEdit,
                                displayName: e.target.value,
                              })
                            }
                            disabled={busy}
                          />
                        </div>
                      </>
                    )}
                  </div>
                  {nameEdit.kind === 'person' && (
                    <EvidenceFields
                      idPrefix="correct-name"
                      kinds={BASIC_KINDS}
                      value={nameEvidence}
                      onChange={setNameEvidence}
                      disabled={busy}
                    />
                  )}
                  <div className="btn-row">
                    <button
                      className="btn btn--small"
                      type="submit"
                      disabled={busy}
                    >
                      Save correction
                    </button>
                    <button
                      className="btn btn--small btn--outline"
                      type="button"
                      onClick={() => setNameEdit(null)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              <h2>People</h2>
              <div className="panel-list" style={{ marginBottom: '22px' }}>
                {roster.people.length === 0 ? (
                  <p className="muted panel-pad">No people recorded yet.</p>
                ) : (
                  roster.people.map((person) => (
                    <div
                      key={person.partyId}
                      className="panel-card"
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="list-row">
                        <div className="admin-row-main">
                          <div className="admin-row-title">
                            {person.displayName}
                            {person.nameRedacted ? ' — name redacted' : ''}
                          </div>
                          {person.consolidatedIntoPartyId && (
                            <div className="admin-row-sub">
                              Consolidated into{' '}
                              {partyLabel(person.consolidatedIntoPartyId)}
                            </div>
                          )}
                        </div>
                        <div className="row-actions">
                          <button
                            className="row-link"
                            type="button"
                            aria-label={`Correct name of ${person.displayName}`}
                            onClick={() =>
                              setNameEdit({
                                partyId: person.partyId,
                                kind: 'person',
                                fullName: person.nameRedacted
                                  ? ''
                                  : person.displayName,
                                legalName: '',
                                displayName: '',
                              })
                            }
                            disabled={busy}
                          >
                            Correct name
                          </button>
                          {person.consolidatedIntoPartyId && (
                            <button
                              className="row-link"
                              type="button"
                              aria-label={`Correct consolidation of ${person.displayName}`}
                              onClick={() => undoConsolidation(person.partyId)}
                              disabled={busy}
                            >
                              Correct consolidation
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <h2>Organizations</h2>
              <div className="panel-list">
                {roster.organizations.length === 0 ? (
                  <p className="muted panel-pad">
                    No organizations recorded yet.
                  </p>
                ) : (
                  roster.organizations.map((org) => (
                    <div
                      key={org.partyId}
                      className="panel-card"
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="list-row">
                        <div className="admin-row-main">
                          <div className="admin-row-title">
                            {org.displayName ?? org.legalName}
                          </div>
                          <div className="admin-row-sub">
                            Legal name: {org.legalName}
                          </div>
                          {org.consolidatedIntoPartyId && (
                            <div className="admin-row-sub">
                              Consolidated into{' '}
                              {partyLabel(org.consolidatedIntoPartyId)}
                            </div>
                          )}
                        </div>
                        <div className="row-actions">
                          <button
                            className="row-link"
                            type="button"
                            aria-label={`Correct name of ${org.legalName}`}
                            onClick={() =>
                              setNameEdit({
                                partyId: org.partyId,
                                kind: 'organization',
                                fullName: '',
                                legalName: org.legalName,
                                displayName: org.displayName ?? '',
                              })
                            }
                            disabled={busy}
                          >
                            Correct name
                          </button>
                          {org.consolidatedIntoPartyId && (
                            <button
                              className="row-link"
                              type="button"
                              aria-label={`Correct consolidation of ${org.legalName}`}
                              onClick={() => undoConsolidation(org.partyId)}
                              disabled={busy}
                            >
                              Correct consolidation
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* ---- Ownerships ---------------------------------------------- */}
          {section === 'ownerships' && (
            <>
              <form
                className="panel-card"
                onSubmit={submitOwnership}
                style={{ marginBottom: '26px' }}
              >
                <div className="panel-editor__title">Record an ownership</div>
                <p className="muted" style={{ marginTop: 0 }}>
                  An ownership starts on a real day and is never future-dated.
                  Ending one is a separate act.
                </p>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="ownership-party">Owner</label>
                    <select
                      id="ownership-party"
                      value={ownershipForm.ownerPartyId}
                      onChange={(e) =>
                        setOwnershipForm({
                          ...ownershipForm,
                          ownerPartyId: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    >
                      <option value="">— choose a party —</option>
                      {partyOptions.map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="ownership-lot">Lot</label>
                    <select
                      id="ownership-lot"
                      value={ownershipForm.lotId}
                      onChange={(e) =>
                        setOwnershipForm({
                          ...ownershipForm,
                          lotId: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    >
                      <option value="">— choose a lot —</option>
                      {lotOptions.map((lot) => (
                        <option key={lot.id} value={lot.id}>
                          {lot.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="ownership-start">Start day</label>
                    <input
                      id="ownership-start"
                      type="date"
                      value={ownershipForm.startDay}
                      onChange={(e) =>
                        setOwnershipForm({
                          ...ownershipForm,
                          startDay: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    />
                  </div>
                </div>
                <EvidenceFields
                  idPrefix="ownership"
                  kinds={ROSTER_KINDS}
                  value={ownershipEvidence}
                  onChange={setOwnershipEvidence}
                  disabled={busy}
                />
                <div className="btn-row">
                  <button
                    className="btn btn--small"
                    type="submit"
                    disabled={busy}
                  >
                    Record ownership
                  </button>
                </div>
              </form>

              <div className="panel-list">
                {roster.ownerships.length === 0 ? (
                  <p className="muted panel-pad">No ownerships recorded yet.</p>
                ) : (
                  roster.ownerships.map((ownership) => (
                    <div
                      key={ownership.id}
                      className="panel-card"
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="list-row">
                        <div className="admin-row-main">
                          <div className="admin-row-title">
                            {partyLabel(ownership.ownerPartyId)} —{' '}
                            {lotLabel(ownership.lotId)}
                          </div>
                          <div className="admin-row-sub">
                            {dayText(ownership.startDay)} to{' '}
                            {dayText(ownership.endDay)}
                            {ownership.voided
                              ? ' · voided'
                              : ownership.current
                                ? ' · current'
                                : ''}
                          </div>
                        </div>
                        {!ownership.voided && (
                          <div className="row-actions">
                            <button
                              className="row-link"
                              type="button"
                              aria-label={`End ownership of ${lotLabel(ownership.lotId)} by ${partyLabel(ownership.ownerPartyId)}`}
                              onClick={() => {
                                setEndingOwnershipId(ownership.id);
                                setOwnershipEndDay('');
                                setOwnershipSubs([]);
                                setOwnershipEndEvidence(NO_EVIDENCE);
                              }}
                              disabled={busy}
                            >
                              End
                            </button>
                            <button
                              className="row-link row-link--danger"
                              type="button"
                              aria-label={`Void ownership of ${lotLabel(ownership.lotId)} by ${partyLabel(ownership.ownerPartyId)}`}
                              onClick={() => removeOwnership(ownership.id)}
                              disabled={busy}
                            >
                              Void
                            </button>
                          </div>
                        )}
                      </div>
                      {endingOwnershipId === ownership.id && (
                        <form
                          onSubmit={submitOwnershipEnd}
                          style={{ marginTop: '14px' }}
                        >
                          <div className="panel-editor__title">
                            End this ownership
                          </div>
                          <p className="muted" style={{ marginTop: 0 }}>
                            Ending a current ownership is a transfer: it resets
                            the lot’s open member-motion votes and opens review
                            flags for anything else it disturbs.
                          </p>
                          <div
                            className="field-grid"
                            style={{ marginBottom: '16px' }}
                          >
                            <div className="field" style={{ margin: 0 }}>
                              <label htmlFor="ownership-end-day">End day</label>
                              <input
                                id="ownership-end-day"
                                type="date"
                                value={ownershipEndDay}
                                onChange={(e) =>
                                  setOwnershipEndDay(e.target.value)
                                }
                                required
                                disabled={busy}
                              />
                            </div>
                          </div>
                          <SubstitutionEditor
                            idPrefix="ownership-end"
                            rows={ownershipSubs}
                            lots={lotOptions}
                            onChange={setOwnershipSubs}
                            disabled={busy}
                          />
                          <EvidenceFields
                            idPrefix="ownership-end"
                            kinds={ROSTER_KINDS}
                            value={ownershipEndEvidence}
                            onChange={setOwnershipEndEvidence}
                            disabled={busy}
                          />
                          <div className="btn-row">
                            <button
                              className="btn btn--small"
                              type="submit"
                              disabled={busy}
                            >
                              End ownership
                            </button>
                            <button
                              className="btn btn--small btn--outline"
                              type="button"
                              onClick={() => setEndingOwnershipId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* ---- Representations ----------------------------------------- */}
          {section === 'representations' && (
            <>
              <form
                className="panel-card"
                onSubmit={submitRepresentation}
                style={{ marginBottom: '26px' }}
              >
                <div className="panel-editor__title">
                  Record a representation
                </div>
                <p className="muted" style={{ marginTop: 0 }}>
                  A representation covers either every lot the organization
                  currently owns, or a named list of them — never both.
                </p>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="rep-person">Representative</label>
                    <select
                      id="rep-person"
                      value={repForm.representativePersonId}
                      onChange={(e) =>
                        setRepForm({
                          ...repForm,
                          representativePersonId: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    >
                      <option value="">— choose a person —</option>
                      {roster.people.map((person) => (
                        <option key={person.partyId} value={person.partyId}>
                          {person.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="rep-org">Organization</label>
                    <select
                      id="rep-org"
                      value={repForm.organizationPartyId}
                      onChange={(e) =>
                        setRepForm({
                          ...repForm,
                          organizationPartyId: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    >
                      <option value="">— choose an organization —</option>
                      {roster.organizations.map((org) => (
                        <option key={org.partyId} value={org.partyId}>
                          {org.displayName ?? org.legalName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="rep-start">Start day</label>
                    <input
                      id="rep-start"
                      type="date"
                      value={repForm.startDay}
                      onChange={(e) =>
                        setRepForm({ ...repForm, startDay: e.target.value })
                      }
                      required
                      disabled={busy}
                    />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="rep-end">
                      End day (optional; may be future)
                    </label>
                    <input
                      id="rep-end"
                      type="date"
                      value={repForm.endDay}
                      onChange={(e) =>
                        setRepForm({ ...repForm, endDay: e.target.value })
                      }
                      disabled={busy}
                    />
                  </div>
                </div>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="rep-scope">Scope</label>
                    <select
                      id="rep-scope"
                      value={repForm.scopeKind}
                      onChange={(e) =>
                        setRepForm({
                          ...repForm,
                          scopeKind: e.target.value as RepresentationScopeKind,
                          lotIds: [],
                        })
                      }
                      disabled={busy}
                    >
                      <option value="organization">
                        Every lot the organization owns
                      </option>
                      <option value="lots">Named lots only</option>
                    </select>
                  </div>
                  {repForm.scopeKind === 'lots' && (
                    <div className="field" style={{ margin: 0 }}>
                      <label htmlFor="rep-lots">Lots in scope</label>
                      <select
                        id="rep-lots"
                        multiple
                        value={repForm.lotIds}
                        onChange={(e) =>
                          setRepForm({
                            ...repForm,
                            lotIds: Array.from(
                              e.target.selectedOptions,
                              (option) => option.value,
                            ),
                          })
                        }
                        disabled={busy}
                      >
                        {lotOptions.map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lot.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <EvidenceFields
                  idPrefix="rep"
                  kinds={ROSTER_KINDS}
                  value={repEvidence}
                  onChange={setRepEvidence}
                  disabled={busy}
                />
                <div className="btn-row">
                  <button
                    className="btn btn--small"
                    type="submit"
                    disabled={busy}
                  >
                    Record representation
                  </button>
                </div>
              </form>

              <div className="panel-list">
                {roster.representations.length === 0 ? (
                  <p className="muted panel-pad">
                    No representations recorded yet.
                  </p>
                ) : (
                  roster.representations.map((rep) => (
                    <div
                      key={rep.id}
                      className="panel-card"
                      style={{ marginBottom: '14px' }}
                    >
                      <div className="list-row">
                        <div className="admin-row-main">
                          <div className="admin-row-title">
                            {partyLabel(rep.representativePersonId)} for{' '}
                            {partyLabel(rep.organizationPartyId)}
                          </div>
                          <div className="admin-row-sub">
                            {rep.scopeKind === 'organization'
                              ? 'Every lot the organization owns'
                              : `Lots: ${rep.scopeLotIds.map(lotLabel).join(', ') || 'none'}`}
                          </div>
                          <div className="admin-row-sub">
                            {dayText(rep.startDay)} to {dayText(rep.endDay)}
                            {rep.voided
                              ? ' · voided'
                              : rep.current
                                ? ' · current'
                                : ''}
                          </div>
                        </div>
                        {!rep.voided && (
                          <div className="row-actions">
                            <button
                              className="row-link"
                              type="button"
                              aria-label={`End representation by ${partyLabel(rep.representativePersonId)}`}
                              onClick={() => {
                                setEndingRepId(rep.id);
                                setScopeEditId(null);
                                setRepEndDay('');
                                setRepEndSubs([]);
                                setRepEndEvidence(NO_EVIDENCE);
                              }}
                              disabled={busy}
                            >
                              End
                            </button>
                            <button
                              className="row-link"
                              type="button"
                              aria-label={`Correct scope of representation by ${partyLabel(rep.representativePersonId)}`}
                              onClick={() => {
                                setScopeEditId(rep.id);
                                setEndingRepId(null);
                                setScopeEdit({
                                  scopeKind: rep.scopeKind,
                                  lotIds: rep.scopeLotIds,
                                });
                              }}
                              disabled={busy}
                            >
                              Correct scope
                            </button>
                            <button
                              className="row-link row-link--danger"
                              type="button"
                              aria-label={`Void representation by ${partyLabel(rep.representativePersonId)}`}
                              onClick={() => removeRepresentation(rep.id)}
                              disabled={busy}
                            >
                              Void
                            </button>
                          </div>
                        )}
                      </div>

                      {endingRepId === rep.id && (
                        <form
                          onSubmit={submitRepresentationEnd}
                          style={{ marginTop: '14px' }}
                        >
                          <div className="panel-editor__title">
                            End this representation
                          </div>
                          <div
                            className="field-grid"
                            style={{ marginBottom: '16px' }}
                          >
                            <div className="field" style={{ margin: 0 }}>
                              <label htmlFor="rep-end-day">
                                End day (defaults to today)
                              </label>
                              <input
                                id="rep-end-day"
                                type="date"
                                value={repEndDay}
                                onChange={(e) => setRepEndDay(e.target.value)}
                                disabled={busy}
                              />
                            </div>
                          </div>
                          <SubstitutionEditor
                            idPrefix="rep-end"
                            rows={repEndSubs}
                            lots={lotOptions}
                            onChange={setRepEndSubs}
                            disabled={busy}
                          />
                          <EvidenceFields
                            idPrefix="rep-end"
                            kinds={ROSTER_KINDS}
                            value={repEndEvidence}
                            onChange={setRepEndEvidence}
                            disabled={busy}
                          />
                          <div className="btn-row">
                            <button
                              className="btn btn--small"
                              type="submit"
                              disabled={busy}
                            >
                              End representation
                            </button>
                            <button
                              className="btn btn--small btn--outline"
                              type="button"
                              onClick={() => setEndingRepId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}

                      {scopeEditId === rep.id && (
                        <form
                          onSubmit={submitScopeCorrection}
                          style={{ marginTop: '14px' }}
                        >
                          <div className="panel-editor__title">
                            Correct the scope
                          </div>
                          <p className="muted" style={{ marginTop: 0 }}>
                            Replaced scope rows are voided, never deleted.
                          </p>
                          <div
                            className="field-grid"
                            style={{ marginBottom: '16px' }}
                          >
                            <div className="field" style={{ margin: 0 }}>
                              <label htmlFor="scope-kind">Scope</label>
                              <select
                                id="scope-kind"
                                value={scopeEdit.scopeKind}
                                onChange={(e) =>
                                  setScopeEdit({
                                    scopeKind: e.target
                                      .value as RepresentationScopeKind,
                                    lotIds: [],
                                  })
                                }
                                disabled={busy}
                              >
                                <option value="organization">
                                  Every lot the organization owns
                                </option>
                                <option value="lots">Named lots only</option>
                              </select>
                            </div>
                            {scopeEdit.scopeKind === 'lots' && (
                              <div className="field" style={{ margin: 0 }}>
                                <label htmlFor="scope-lots">
                                  Lots in scope
                                </label>
                                <select
                                  id="scope-lots"
                                  multiple
                                  value={scopeEdit.lotIds}
                                  onChange={(e) =>
                                    setScopeEdit({
                                      ...scopeEdit,
                                      lotIds: Array.from(
                                        e.target.selectedOptions,
                                        (option) => option.value,
                                      ),
                                    })
                                  }
                                  disabled={busy}
                                >
                                  {lotOptions.map((lot) => (
                                    <option key={lot.id} value={lot.id}>
                                      {lot.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                          <div className="btn-row">
                            <button
                              className="btn btn--small"
                              type="submit"
                              disabled={busy}
                            >
                              Save scope
                            </button>
                            <button
                              className="btn btn--small btn--outline"
                              type="button"
                              onClick={() => setScopeEditId(null)}
                              disabled={busy}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* ---- Contact methods ----------------------------------------- */}
          {section === 'contacts' && (
            <>
              <form
                className="panel-card"
                onSubmit={submitContact}
                style={{ marginBottom: '26px' }}
              >
                <div className="panel-editor__title">Add a contact method</div>
                <p className="muted" style={{ marginTop: 0 }}>
                  The ledger records that a contact changed and on which channel
                  — never the value itself.
                </p>
                <div className="field-grid" style={{ marginBottom: '16px' }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="contact-party">Party</label>
                    <select
                      id="contact-party"
                      value={contactForm.partyId}
                      onChange={(e) =>
                        setContactForm({
                          ...contactForm,
                          partyId: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    >
                      <option value="">— choose a party —</option>
                      {partyOptions.map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="contact-channel">Channel</label>
                    <select
                      id="contact-channel"
                      value={contactForm.channel}
                      onChange={(e) =>
                        setContactForm({
                          ...contactForm,
                          channel: e.target.value as ContactChannel,
                        })
                      }
                      disabled={busy}
                    >
                      <option value="email">Email</option>
                      <option value="sms">Text message</option>
                    </select>
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="contact-value">Value</label>
                    <input
                      id="contact-value"
                      type="text"
                      value={contactForm.value}
                      onChange={(e) =>
                        setContactForm({
                          ...contactForm,
                          value: e.target.value,
                        })
                      }
                      required
                      disabled={busy}
                    />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="contact-start">Start day (optional)</label>
                    <input
                      id="contact-start"
                      type="date"
                      value={contactForm.startDay}
                      onChange={(e) =>
                        setContactForm({
                          ...contactForm,
                          startDay: e.target.value,
                        })
                      }
                      disabled={busy}
                    />
                  </div>
                </div>
                <div className="field" style={{ marginBottom: '16px' }}>
                  <label htmlFor="contact-preferred">
                    <input
                      id="contact-preferred"
                      type="checkbox"
                      checked={contactForm.isPreferred}
                      onChange={(e) =>
                        setContactForm({
                          ...contactForm,
                          isPreferred: e.target.checked,
                        })
                      }
                      disabled={busy}
                    />{' '}
                    Make this the preferred method on its channel
                  </label>
                </div>
                <div className="btn-row">
                  <button
                    className="btn btn--small"
                    type="submit"
                    disabled={busy}
                  >
                    Add contact method
                  </button>
                </div>
              </form>

              <div className="field" style={{ marginBottom: '16px' }}>
                <label htmlFor="contact-filter">Show contacts for</label>
                <select
                  id="contact-filter"
                  value={contactFilter}
                  onChange={(e) => setContactFilter(e.target.value)}
                >
                  <option value="">— every party —</option>
                  {partyOptions.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="panel-list">
                {roster.contactMethods.length === 0 ? (
                  <p className="muted panel-pad">
                    No contact methods recorded yet.
                  </p>
                ) : (
                  roster.contactMethods
                    .filter(
                      (contact) =>
                        contactFilter === '' ||
                        contact.partyId === contactFilter,
                    )
                    .map((contact) => (
                      <div
                        key={contact.id}
                        className="panel-card"
                        style={{ marginBottom: '14px' }}
                      >
                        <div className="list-row">
                          <div className="admin-row-main">
                            <div className="admin-row-title">
                              {partyLabel(contact.partyId)} —{' '}
                              {contact.channel === 'email'
                                ? 'Email'
                                : 'Text message'}
                              : {contact.redacted ? 'redacted' : contact.value}
                            </div>
                            <div className="admin-row-sub">
                              {dayText(contact.startDay)} to{' '}
                              {dayText(contact.endDay)}
                              {contact.isPreferred ? ' · preferred' : ''}
                              {contact.voided ? ' · voided' : ''}
                            </div>
                          </div>
                          {!contact.voided && (
                            <div className="row-actions">
                              {!contact.isPreferred && (
                                <button
                                  className="row-link"
                                  type="button"
                                  aria-label={`Set preferred contact method for ${partyLabel(contact.partyId)}`}
                                  onClick={() => preferContact(contact.id)}
                                  disabled={busy}
                                >
                                  Set preferred
                                </button>
                              )}
                              <button
                                className="row-link"
                                type="button"
                                aria-label={`End contact method for ${partyLabel(contact.partyId)}`}
                                onClick={() => {
                                  setEndingContactId(contact.id);
                                  setContactEndDay('');
                                }}
                                disabled={busy}
                              >
                                End
                              </button>
                              <button
                                className="row-link row-link--danger"
                                type="button"
                                aria-label={`Void contact method for ${partyLabel(contact.partyId)}`}
                                onClick={() => removeContact(contact.id)}
                                disabled={busy}
                              >
                                Void
                              </button>
                            </div>
                          )}
                        </div>
                        {endingContactId === contact.id && (
                          <form
                            onSubmit={submitContactEnd}
                            style={{ marginTop: '14px' }}
                          >
                            <div className="field-grid">
                              <div className="field" style={{ margin: 0 }}>
                                <label htmlFor="contact-end-day">
                                  End day (defaults to today)
                                </label>
                                <input
                                  id="contact-end-day"
                                  type="date"
                                  value={contactEndDay}
                                  onChange={(e) =>
                                    setContactEndDay(e.target.value)
                                  }
                                  disabled={busy}
                                />
                              </div>
                            </div>
                            <div className="btn-row">
                              <button
                                className="btn btn--small"
                                type="submit"
                                disabled={busy}
                              >
                                End contact method
                              </button>
                              <button
                                className="btn btn--small btn--outline"
                                type="button"
                                onClick={() => setEndingContactId(null)}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    ))
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
