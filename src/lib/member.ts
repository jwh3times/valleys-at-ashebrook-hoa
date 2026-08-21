// Client helpers for the homeowner-write endpoints (/api/member/*). Same
// fetch-and-throw-text shape as src/lib/admin.ts, so form components can
// surface the server's readable error messages directly.
import type { MemberProxyLists } from './types';

export interface GrantProxyInput {
  propertyId: string;
  grantorPersonId: string;
  holderPersonId: string;
  meetingId?: string | null;
  electionId?: string | null;
}

/**
 * The Persons who may act for one lot. The endpoint keeps its
 * `/api/member/owner-lookup` path — #248 part 2 changed what it reads, not
 * where it lives, and a URL rename is a separate, deploy-visible change.
 */
export interface LotPersonLookupResult {
  propertyId: string;
  address: string;
  persons: { id: string; fullName: string }[];
}

export async function fetchMyProxies(): Promise<MemberProxyLists> {
  const res = await fetch('/api/member/proxies');
  if (!res.ok) throw new Error(`Load proxies failed: ${res.status}`);
  return res.json();
}

export async function grantProxy(data: GrantProxyInput): Promise<void> {
  const res = await fetch('/api/member/proxies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Grant failed: ${res.status}`);
}

export async function revokeProxy(id: string): Promise<void> {
  const res = await fetch('/api/member/proxies', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Revoke failed: ${res.status}`);
}

export async function lookupLotPersons(
  address: string,
): Promise<LotPersonLookupResult> {
  const res = await fetch('/api/member/owner-lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Lookup failed: ${res.status}`);
  return res.json();
}
