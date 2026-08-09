// Admin-only write helpers.
import type {
  Announcement,
  AdminDocumentItem,
  DuesSettings,
  SiteSettings,
  PropertyWithOwners,
  MembersView,
  MemberUser,
  DuplicatesView,
  BoardPersonWithTerms,
  MeetingSummary,
  MeetingDetail,
  MeetingInput,
  MotionInput,
  VoteChoice,
  MemberVoteChoice,
  ResolutionDetail,
  ResolutionInput,
  ElectionDetail,
  ElectionInput,
  CandidateInput,
  ProxyDetail,
  ProxyInput,
} from './types';
import type { ReportListItem, ReportDetail } from './reports';

/**
 * Every admin write goes through here, so that a failure surfaces the
 * server's own message.
 *
 * The routes go to real trouble over those messages — "Proxy is in use
 * (attendance) — remove those records first", "Inactive lots cannot be
 * recorded present: …" — and 22 of the 63 hand-written error branches this
 * replaces threw `Delete failed: 409` instead, discarding the explanation
 * the board needed. The contract is now a property of the module rather
 * than something each caller remembers.
 *
 * `fallback` is used only when the response body is empty.
 */
async function adminRequest<T = void>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  fallback = 'Request failed',
): Promise<T> {
  // A GET is issued as `fetch(url)` with no init at all, matching what the
  // read helpers did before — the call shape is observable from tests.
  const res =
    method === 'GET'
      ? await fetch(url)
      : await fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
  if (!res.ok)
    throw new Error((await res.text()) || `${fallback}: ${res.status}`);
  // 204 is the norm for admin writes; only reads and creates carry a body.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The `{ action, … }` POST shape 22 of the admin endpoints use. */
async function adminAction<T = void>(
  url: string,
  action: string,
  payload: Record<string, unknown> = {},
  fallback = 'Action failed',
): Promise<T> {
  return adminRequest<T>(url, 'POST', { action, ...payload }, fallback);
}

/**
 * Create-or-update: an id means PATCH with the id folded in, no id means
 * POST. Nine `save*` helpers were spelling this out identically.
 */
async function adminSave<T = void>(
  url: string,
  data: unknown,
  id: string | undefined,
  fallback = 'Save failed',
): Promise<T> {
  return adminRequest<T>(
    url,
    id ? 'PATCH' : 'POST',
    id ? { id, ...(data as object) } : data,
    fallback,
  );
}

// ---------- Announcements ----------
export async function saveAnnouncement(
  data: Omit<Announcement, 'id'>,
  id?: string,
): Promise<void> {
  if (id) {
    await adminRequest(
      '/api/admin/announcements',
      'PATCH',
      { id, ...data },
      'Update failed',
    );
  } else {
    await adminRequest(
      '/api/admin/announcements',
      'POST',
      data,
      'Create failed',
    );
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/announcements',
    'DELETE',
    { id },
    'Delete failed',
  );
}

// ---------- Documents ----------
export async function fetchAdminDocuments(): Promise<AdminDocumentItem[]> {
  return adminRequest<AdminDocumentItem[]>(
    '/api/admin/documents',
    'GET',
    undefined,
    'Load admin documents failed',
  );
}

export class DuplicateError extends Error {
  kind: 'exact' | 'near';
  existing?: {
    id: string;
    title?: string;
    category?: string;
    visibility?: string;
  };
  similar?: {
    id: string;
    title?: string;
    filename?: string;
    category?: string;
    visibility?: string;
  }[];

  constructor(
    kind: 'exact' | 'near',
    payload: {
      existing?: DuplicateError['existing'];
      similar?: DuplicateError['similar'];
    },
  ) {
    super(kind === 'exact' ? 'exact-duplicate' : 'near-duplicate');
    this.name = 'DuplicateError';
    this.kind = kind;
    this.existing = payload.existing;
    this.similar = payload.similar;
  }
}

export async function uploadDocument(
  file: File,
  title: string,
  category: string,
  visibility: string = 'board',
  confirmDuplicate: boolean = false,
): Promise<void> {
  const form = new FormData();
  form.set('file', file);
  form.set('title', title);
  form.set('category', category);
  form.set('visibility', visibility);
  if (confirmDuplicate) form.set('confirmDuplicate', 'true');
  const res = await fetch('/api/admin/documents', {
    method: 'POST',
    body: form,
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      warning?: string;
      existing?: DuplicateError['existing'];
      similar?: DuplicateError['similar'];
    };
    if (body.error === 'exact-duplicate')
      throw new DuplicateError('exact', { existing: body.existing });
    if (body.warning === 'near-duplicate')
      throw new DuplicateError('near', { similar: body.similar });
  }
  // Same contract as adminRequest, spelled out because this one posts
  // FormData and has to inspect a 409 body for the duplicate cases first.
  if (!res.ok)
    throw new Error((await res.text()) || `Upload failed: ${res.status}`);
}

export async function fetchDuplicates(): Promise<DuplicatesView> {
  return adminRequest<DuplicatesView>(
    '/api/admin/duplicates',
    'GET',
    undefined,
    'Load duplicates failed',
  );
}

export async function resolveDuplicates(
  keepIds: string[],
  deleteIds: string[],
): Promise<void> {
  await adminRequest(
    '/api/admin/duplicates',
    'POST',
    { action: 'resolve', keepIds, deleteIds },
    'Resolve failed',
  );
}

export async function editDocument(
  id: string,
  patch: { title?: string; category?: string; visibility?: string },
): Promise<void> {
  await adminRequest(
    '/api/admin/documents',
    'PATCH',
    { id, ...patch },
    'Edit failed',
  );
}

export async function deleteDocument(id: string): Promise<void> {
  await adminRequest('/api/admin/documents', 'DELETE', { id }, 'Delete failed');
}

// ---------- Settings (singletons) ----------
export async function saveDues(dues: DuesSettings): Promise<void> {
  await adminRequest('/api/admin/dues', 'PUT', dues, 'Save dues failed');
}

export async function saveSite(site: SiteSettings): Promise<void> {
  await adminRequest('/api/admin/site', 'PUT', site, 'Save site failed');
}

// ---------- Roster (board-only reads + writes) ----------
export async function fetchProperties(): Promise<PropertyWithOwners[]> {
  return adminRequest(
    '/api/admin/properties',
    'GET',
    undefined,
    'Load homes failed',
  );
}

export async function saveProperty(
  data: {
    address?: string;
    unit?: string | null;
    notes?: string | null;
    status?: 'active' | 'inactive';
    voteWeight?: number;
  },
  id?: string,
): Promise<void> {
  await adminSave('/api/admin/properties', data, id, 'Save home failed');
}

export async function saveOwner(
  data: {
    propertyId?: string;
    fullName?: string;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
    status?: 'active' | 'inactive';
  },
  id?: string,
): Promise<void> {
  await adminSave('/api/admin/owners', data, id, 'Save owner failed');
}

// ---------- Members / access ----------
export async function fetchMembers(): Promise<MembersView> {
  return adminRequest(
    '/api/admin/members',
    'GET',
    undefined,
    'Load members failed',
  );
}

export async function memberAction(payload: {
  action: 'approve' | 'deny' | 'revoke';
  userId?: string;
  queueId?: string;
  propertyId?: string;
}): Promise<void> {
  await adminRequest('/api/admin/members', 'POST', payload, 'Action failed');
}

// ---------- Board membership (handoff) ----------
export async function fetchBoardMembers(): Promise<MemberUser[]> {
  const data = await adminRequest<{ board: MemberUser[] }>(
    '/api/admin/roles',
    'GET',
    undefined,
    'Load board failed',
  );
  return data.board;
}

export async function promoteToBoard(email: string): Promise<void> {
  await adminRequest(
    '/api/admin/roles',
    'POST',
    { action: 'promote', email },
    'Promote failed',
  );
}

export async function demoteFromBoard(userId: string): Promise<void> {
  await adminRequest(
    '/api/admin/roles',
    'POST',
    { action: 'demote', userId },
    'Demote failed',
  );
}

// ---------- Reports ----------
export async function fetchReports(): Promise<ReportListItem[]> {
  return adminRequest<ReportListItem[]>(
    '/api/admin/reports',
    'GET',
    undefined,
    'Load reports failed',
  );
}

export async function fetchReport(id: string): Promise<ReportDetail> {
  return adminRequest<ReportDetail>(
    `/api/admin/reports?id=${encodeURIComponent(id)}`,
    'GET',
    undefined,
    'Load report failed',
  );
}

export async function deleteReport(id: string): Promise<void> {
  await adminRequest('/api/admin/reports', 'DELETE', { id }, 'Delete failed');
}

// ---------- Board roster ----------
export async function fetchBoardPeople(): Promise<BoardPersonWithTerms[]> {
  return adminRequest(
    '/api/admin/board-people',
    'GET',
    undefined,
    'Load board failed',
  );
}

export async function saveBoardPerson(
  data: { fullName?: string; userId?: string | null },
  id?: string,
): Promise<void> {
  await adminSave('/api/admin/board-people', data, id, 'Save person failed');
}

export async function deleteBoardPerson(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/board-people',
    'DELETE',
    { id },
    'Delete failed',
  );
}

export async function saveBoardTerm(
  data: {
    personId?: string;
    title?: string | null;
    termStart?: string;
    termEnd?: string | null;
  },
  id?: string,
): Promise<void> {
  await adminSave('/api/admin/board-terms', data, id, 'Save term failed');
}

export async function deleteBoardTerm(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/board-terms',
    'DELETE',
    { id },
    'Delete failed',
  );
}

// ---------- Meetings ----------
// Named fetchMeetings, not fetchAdminMeetings: that name already belongs to the
// server-side read helper in src/server/content/reads.ts, and this module is
// entirely admin-scoped, so the prefix would carry no information here.
export async function fetchMeetings(): Promise<MeetingSummary[]> {
  return adminRequest(
    '/api/admin/meetings',
    'GET',
    undefined,
    'Load meetings failed',
  );
}

export async function fetchMeeting(id: string): Promise<MeetingDetail> {
  return adminRequest(
    `/api/admin/meetings?id=${encodeURIComponent(id)}`,
    'GET',
    undefined,
    'Load meeting failed',
  );
}

export async function saveMeeting(
  data: MeetingInput,
  id?: string,
): Promise<void> {
  await adminSave('/api/admin/meetings', data, id, 'Save meeting failed');
}

export async function deleteMeeting(id: string): Promise<void> {
  await adminRequest('/api/admin/meetings', 'DELETE', { id }, 'Delete failed');
}

export async function approveMeeting(meetingId: string): Promise<void> {
  await adminRequest(
    '/api/admin/meetings',
    'POST',
    { action: 'approve', meetingId },
    'Approve failed',
  );
}

export async function unapproveMeeting(meetingId: string): Promise<void> {
  await adminRequest(
    '/api/admin/meetings',
    'POST',
    { action: 'unapprove', meetingId },
    'Unapprove failed',
  );
}

export async function setAttendance(
  meetingId: string,
  entries: { personId: string; present: boolean }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/meetings',
    'POST',
    { action: 'setAttendance', meetingId, entries },
    'Save attendance failed',
  );
}

export async function setMemberAttendance(
  meetingId: string,
  entries: {
    propertyId: string;
    present: boolean;
    representedByOwnerId?: string | null;
    proxyId?: string | null;
  }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/meetings',
    'POST',
    {
      action: 'setMemberAttendance',
      meetingId,
      entries,
    },
    'Save attendance failed',
  );
}

// ---------- Motions ----------
export async function saveMotion(
  data: MotionInput,
  id?: string,
): Promise<string | undefined> {
  if (id) {
    await adminRequest(
      '/api/admin/motions',
      'PATCH',
      { id, ...data },
      'Save motion failed',
    );
    return undefined;
  }
  // Create returns { id } — the caller needs it right away to record the
  // roll call for the motion it just created.
  const body = await adminRequest<{ id: string }>(
    '/api/admin/motions',
    'POST',
    data,
    'Save motion failed',
  );
  return body.id;
}

export async function deleteMotion(id: string): Promise<void> {
  await adminRequest('/api/admin/motions', 'DELETE', { id }, 'Delete failed');
}

export async function openMotionVoting(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/motions',
    'POST',
    { action: 'openVoting', id },
    'Open voting failed',
  );
}

export async function closeMotionVoting(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/motions',
    'POST',
    { action: 'closeVoting', id },
    'Close voting failed',
  );
}

export async function setVotes(
  motionId: string,
  entries: { personId: string; choice: VoteChoice }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/motions',
    'POST',
    { action: 'setVotes', motionId, entries },
    'Save votes failed',
  );
}

export async function setMemberVotes(
  motionId: string,
  entries: {
    propertyId: string;
    choice: MemberVoteChoice;
    castByOwnerId?: string | null;
    proxyId?: string | null;
  }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/motions',
    'POST',
    { action: 'setMemberVotes', motionId, entries },
    'Save votes failed',
  );
}

// ---------- Resolutions ----------
// GET already returns every resolution's full detail (drafts included, no
// tier filter — see fetchAdminResolutions), so unlike meetings/motions there
// is no separate single-record fetch: the list read IS the detail read.
export async function fetchResolutions(): Promise<ResolutionDetail[]> {
  return adminRequest(
    '/api/admin/resolutions',
    'GET',
    undefined,
    'Load resolutions failed',
  );
}

export async function saveResolution(
  data: ResolutionInput,
  id?: string,
): Promise<void> {
  await adminSave('/api/admin/resolutions', data, id, 'Save resolution failed');
}

export async function deleteResolution(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/resolutions',
    'DELETE',
    { id },
    'Delete failed',
  );
}

export async function adoptResolution(
  id: string,
  effectiveDate: string,
  motionId?: string | null,
): Promise<void> {
  await adminRequest(
    '/api/admin/resolutions',
    'POST',
    {
      action: 'adopt',
      id,
      effectiveDate,
      motionId: motionId || undefined,
    },
    'Adopt failed',
  );
}

export async function supersedeResolution(
  id: string,
  supersedesId: string,
  effectiveDate: string,
  motionId?: string | null,
): Promise<void> {
  await adminRequest(
    '/api/admin/resolutions',
    'POST',
    {
      action: 'supersede',
      id,
      supersedesId,
      effectiveDate,
      motionId: motionId || undefined,
    },
    'Supersede failed',
  );
}

export async function repealResolution(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/resolutions',
    'POST',
    { action: 'repeal', id },
    'Repeal failed',
  );
}

// ---------- Elections ----------
// GET already returns every election's full detail (drafts included, no tier
// filter, candidates and ballots nested — see fetchAdminElections), so like
// resolutions there is no separate single-election fetch: the list read IS
// the detail read.
export async function fetchElections(): Promise<ElectionDetail[]> {
  return adminRequest(
    '/api/admin/elections',
    'GET',
    undefined,
    'Load elections failed',
  );
}

export async function saveElection(
  data: ElectionInput,
  id?: string,
): Promise<void> {
  const { source, ...patchData } = data;
  void source;
  await adminRequest(
    '/api/admin/elections',
    id ? 'PATCH' : 'POST',
    id ? { id, ...patchData } : data,
    'Save election failed',
  );
}

export async function openElection(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'open', id },
    'Open failed',
  );
}

export async function deleteElection(id: string): Promise<void> {
  await adminRequest('/api/admin/elections', 'DELETE', { id }, 'Delete failed');
}

export async function closeElection(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'close', id },
    'Close failed',
  );
}

export async function voidElection(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'void', id },
    'Void failed',
  );
}

// Per-winner term fields — a single shared termStart would be wrong for a
// staggered board, where the top vote-getter and the runner-up can seat for
// different lengths.
export async function certifyElection(
  id: string,
  winners: {
    candidateId: string;
    termStart: string;
    termEnd?: string | null;
    title?: string | null;
  }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'certify', id, winners },
    'Certify failed',
  );
}

export async function uncertifyElection(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'uncertify', id },
    'Uncertify failed',
  );
}

export async function setTallies(
  electionId: string,
  entries: { candidateId: string; votes: number }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'setTallies', electionId, entries },
    'Save tallies failed',
  );
}

export async function setBallots(
  electionId: string,
  entries: {
    propertyId: string;
    weight?: number;
    proxyId?: string | null;
    castByOwnerId?: string | null;
  }[],
): Promise<void> {
  await adminRequest(
    '/api/admin/elections',
    'POST',
    { action: 'setBallots', electionId, entries },
    'Save ballots failed',
  );
}

// ---------- Candidates ----------
// CandidateInput (unlike MotionInput) carries no electionId — the server
// route reads it as a separate top-level field on create, and ignores it on
// PATCH — so it is a separate parameter here rather than folded into data.
export async function saveCandidate(
  electionId: string,
  data: CandidateInput,
  id?: string,
): Promise<void> {
  await adminRequest(
    '/api/admin/candidates',
    id ? 'PATCH' : 'POST',
    id ? { id, ...data } : { electionId, ...data },
    'Save candidate failed',
  );
}

export async function deleteCandidate(id: string): Promise<void> {
  await adminRequest(
    '/api/admin/candidates',
    'DELETE',
    { id },
    'Delete failed',
  );
}

// ---------- Proxies ----------
// GET returns every proxy with names resolved (see fetchAdminProxies) — like
// resolutions and elections, the list read IS the detail read.
export async function fetchProxies(): Promise<ProxyDetail[]> {
  return adminRequest(
    '/api/admin/proxies',
    'GET',
    undefined,
    'Load proxies failed',
  );
}

export async function saveProxy(data: ProxyInput, id?: string): Promise<void> {
  await adminSave('/api/admin/proxies', data, id, 'Save proxy failed');
}

export async function deleteProxy(id: string): Promise<void> {
  await adminRequest('/api/admin/proxies', 'DELETE', { id }, 'Delete failed');
}
