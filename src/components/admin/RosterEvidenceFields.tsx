import type { BasicEvidence, RosterEvidence } from '../../lib/roster-admin';

type EvidenceKind =
  | 'none'
  | 'operator_observation'
  | 'document'
  | 'external'
  | 'meeting'
  | 'election'
  | 'request';

export interface EvidenceState {
  kind: EvidenceKind;
  reference: string;
}

export const NO_EVIDENCE: EvidenceState = { kind: 'none', reference: '' };

export const BASIC_KINDS: EvidenceKind[] = [
  'none',
  'operator_observation',
  'document',
  'external',
];

export const ROSTER_KINDS: EvidenceKind[] = [
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

export function buildEvidence(
  state: EvidenceState,
): RosterEvidence | undefined {
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

export function buildBasicEvidence(
  state: EvidenceState,
): BasicEvidence | undefined {
  const evidence = buildEvidence(state);
  if (!evidence) return undefined;
  return evidence.kind === 'operator_observation' ||
    evidence.kind === 'document' ||
    evidence.kind === 'external'
    ? evidence
    : undefined;
}

export function EvidenceFields({
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
