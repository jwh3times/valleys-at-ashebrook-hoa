import type { RosterEvidence, TermSubstitution } from './roster-admin';

export interface OwnershipTransferInput {
  lotId: string;
  departingOwnershipIds: string[];
  incomingPartyIds: string[];
  effectiveDay: string;
  evidence?: RosterEvidence;
  substitutions?: TermSubstitution[];
}
interface NamedParty {
  id: string;
  displayName: string;
}
export interface OwnershipTransferPreview {
  token: string;
  lotId: string;
  address: string;
  effectiveDay: string;
  departing: NamedParty[];
  incoming: NamedParty[];
  retained: NamedParty[];
  authorityLost: NamedParty[];
  authorityGained: NamedParty[];
  access: {
    personId: string;
    displayName: string;
    lotAuthority: 'lost' | 'gained';
    memberAccess: 'lost' | 'gained' | 'retained';
  }[];
  boardTerms: {
    termId: string;
    personId: string;
    displayName: string;
    action: 'end' | 'cancel' | 'substitute';
    substituteLotId: string | null;
    availableLots: { id: string; address: string }[];
    offices: string[];
    boardGrantsEnding: number;
  }[];
  resetMotionIds: string[];
  reviewFlagCount: number;
}
async function transferRequest<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/admin/roster-ownerships', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      (await response.text()) || `Transfer failed: ${response.status}`,
    );
  return response.json() as Promise<T>;
}
export function previewOwnershipTransfer(
  input: OwnershipTransferInput,
): Promise<OwnershipTransferPreview> {
  return transferRequest({ action: 'previewTransfer', ...input });
}
export function commitOwnershipTransfer(
  input: OwnershipTransferInput,
  previewToken: string,
): Promise<{ ownershipIds: string[] }> {
  return transferRequest({ action: 'transfer', ...input, previewToken });
}
