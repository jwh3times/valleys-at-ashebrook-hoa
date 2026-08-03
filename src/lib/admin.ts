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
} from './types';
import type { ReportListItem, ReportDetail } from './reports';

// ---------- Announcements ----------
export async function saveAnnouncement(
  data: Omit<Announcement, 'id'>,
  id?: string,
): Promise<void> {
  if (id) {
    const res = await fetch('/api/admin/announcements', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...data }),
    });
    if (!res.ok)
      throw new Error((await res.text()) || `Update failed: ${res.status}`);
  } else {
    const res = await fetch('/api/admin/announcements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok)
      throw new Error((await res.text()) || `Create failed: ${res.status}`);
  }
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const res = await fetch('/api/admin/announcements', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ---------- Documents ----------
export async function fetchAdminDocuments(): Promise<AdminDocumentItem[]> {
  const res = await fetch('/api/admin/documents');
  if (!res.ok) throw new Error(`admin documents ${res.status}`);
  return (await res.json()) as AdminDocumentItem[];
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
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

export async function fetchDuplicates(): Promise<DuplicatesView> {
  const res = await fetch('/api/admin/duplicates');
  if (!res.ok) throw new Error(`duplicates ${res.status}`);
  return (await res.json()) as DuplicatesView;
}

export async function resolveDuplicates(
  keepIds: string[],
  deleteIds: string[],
): Promise<void> {
  const res = await fetch('/api/admin/duplicates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', keepIds, deleteIds }),
  });
  if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
}

export async function editDocument(
  id: string,
  patch: { title?: string; category?: string; visibility?: string },
): Promise<void> {
  const res = await fetch('/api/admin/documents', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  });
  if (!res.ok) throw new Error(`Edit failed: ${res.status}`);
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch('/api/admin/documents', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ---------- Settings (singletons) ----------
export async function saveDues(dues: DuesSettings): Promise<void> {
  const res = await fetch('/api/admin/dues', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dues),
  });
  if (!res.ok) throw new Error(`Save dues failed: ${res.status}`);
}

export async function saveSite(site: SiteSettings): Promise<void> {
  const res = await fetch('/api/admin/site', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(site),
  });
  if (!res.ok) throw new Error(`Save site failed: ${res.status}`);
}

// ---------- Roster (board-only reads + writes) ----------
export async function fetchProperties(): Promise<PropertyWithOwners[]> {
  const res = await fetch('/api/admin/properties');
  if (!res.ok) throw new Error(`Load homes failed: ${res.status}`);
  return res.json();
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
  const res = await fetch('/api/admin/properties', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save home failed: ${res.status}`);
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
  const res = await fetch('/api/admin/owners', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save owner failed: ${res.status}`);
}

// ---------- Members / access ----------
export async function fetchMembers(): Promise<MembersView> {
  const res = await fetch('/api/admin/members');
  if (!res.ok) throw new Error(`Load members failed: ${res.status}`);
  return res.json();
}

export async function memberAction(payload: {
  action: 'approve' | 'deny' | 'revoke';
  userId?: string;
  queueId?: string;
  propertyId?: string;
}): Promise<void> {
  const res = await fetch('/api/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Action failed: ${res.status}`);
}

// ---------- Board membership (handoff) ----------
export async function fetchBoardMembers(): Promise<MemberUser[]> {
  const res = await fetch('/api/admin/roles');
  if (!res.ok) throw new Error(`Load board failed: ${res.status}`);
  const data = (await res.json()) as { board: MemberUser[] };
  return data.board;
}

export async function promoteToBoard(email: string): Promise<void> {
  const res = await fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'promote', email }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Promote failed: ${res.status}`);
}

export async function demoteFromBoard(userId: string): Promise<void> {
  const res = await fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'demote', userId }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Demote failed: ${res.status}`);
}

// ---------- Reports ----------
export async function fetchReports(): Promise<ReportListItem[]> {
  const res = await fetch('/api/admin/reports');
  if (!res.ok) throw new Error(`reports ${res.status}`);
  return (await res.json()) as ReportListItem[];
}

export async function fetchReport(id: string): Promise<ReportDetail> {
  const res = await fetch(`/api/admin/reports?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`report ${res.status}`);
  return (await res.json()) as ReportDetail;
}

export async function deleteReport(id: string): Promise<void> {
  const res = await fetch('/api/admin/reports', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ---------- Board roster ----------
export async function fetchBoardPeople(): Promise<BoardPersonWithTerms[]> {
  const res = await fetch('/api/admin/board-people');
  if (!res.ok) throw new Error(`Load board failed: ${res.status}`);
  return res.json();
}

export async function saveBoardPerson(
  data: { fullName?: string; userId?: string | null },
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/board-people', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save person failed: ${res.status}`);
}

export async function deleteBoardPerson(id: string): Promise<void> {
  const res = await fetch('/api/admin/board-people', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
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
  const res = await fetch('/api/admin/board-terms', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save term failed: ${res.status}`);
}

export async function deleteBoardTerm(id: string): Promise<void> {
  const res = await fetch('/api/admin/board-terms', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
}

// ---------- Meetings ----------
// Named fetchMeetings, not fetchAdminMeetings: that name already belongs to the
// server-side read helper in src/server/content/reads.ts, and this module is
// entirely admin-scoped, so the prefix would carry no information here.
export async function fetchMeetings(): Promise<MeetingSummary[]> {
  const res = await fetch('/api/admin/meetings');
  if (!res.ok) throw new Error(`Load meetings failed: ${res.status}`);
  return res.json();
}

export async function fetchMeeting(id: string): Promise<MeetingDetail> {
  const res = await fetch(`/api/admin/meetings?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Load meeting failed: ${res.status}`);
  return res.json();
}

export async function saveMeeting(
  data: MeetingInput,
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/meetings', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save meeting failed: ${res.status}`);
}

export async function deleteMeeting(id: string): Promise<void> {
  const res = await fetch('/api/admin/meetings', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
}

export async function approveMeeting(meetingId: string): Promise<void> {
  const res = await fetch('/api/admin/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', meetingId }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Approve failed: ${res.status}`);
}

export async function unapproveMeeting(meetingId: string): Promise<void> {
  const res = await fetch('/api/admin/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'unapprove', meetingId }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Unapprove failed: ${res.status}`);
}

export async function setAttendance(
  meetingId: string,
  entries: { personId: string; present: boolean }[],
): Promise<void> {
  const res = await fetch('/api/admin/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setAttendance', meetingId, entries }),
  });
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Save attendance failed: ${res.status}`,
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
  const res = await fetch('/api/admin/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'setMemberAttendance',
      meetingId,
      entries,
    }),
  });
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Save attendance failed: ${res.status}`,
    );
}

// ---------- Motions ----------
export async function saveMotion(
  data: MotionInput,
  id?: string,
): Promise<string | undefined> {
  if (id) {
    const res = await fetch('/api/admin/motions', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...data }),
    });
    if (!res.ok)
      throw new Error(
        (await res.text()) || `Save motion failed: ${res.status}`,
      );
    return undefined;
  }
  const res = await fetch('/api/admin/motions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save motion failed: ${res.status}`);
  // Create returns { id } — the caller needs it right away to record the
  // roll call for the motion it just created.
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function deleteMotion(id: string): Promise<void> {
  const res = await fetch('/api/admin/motions', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
}

export async function setVotes(
  motionId: string,
  entries: { personId: string; choice: VoteChoice }[],
): Promise<void> {
  const res = await fetch('/api/admin/motions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setVotes', motionId, entries }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save votes failed: ${res.status}`);
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
  const res = await fetch('/api/admin/motions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setMemberVotes', motionId, entries }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save votes failed: ${res.status}`);
}

// ---------- Resolutions ----------
// GET already returns every resolution's full detail (drafts included, no
// tier filter — see fetchAdminResolutions), so unlike meetings/motions there
// is no separate single-record fetch: the list read IS the detail read.
export async function fetchResolutions(): Promise<ResolutionDetail[]> {
  const res = await fetch('/api/admin/resolutions');
  if (!res.ok) throw new Error(`Load resolutions failed: ${res.status}`);
  return res.json();
}

export async function saveResolution(
  data: ResolutionInput,
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/resolutions', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Save resolution failed: ${res.status}`,
    );
}

export async function deleteResolution(id: string): Promise<void> {
  const res = await fetch('/api/admin/resolutions', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
}

export async function adoptResolution(
  id: string,
  effectiveDate: string,
  motionId?: string | null,
): Promise<void> {
  const res = await fetch('/api/admin/resolutions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'adopt',
      id,
      effectiveDate,
      motionId: motionId || undefined,
    }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Adopt failed: ${res.status}`);
}

export async function supersedeResolution(
  id: string,
  supersedesId: string,
  effectiveDate: string,
  motionId?: string | null,
): Promise<void> {
  const res = await fetch('/api/admin/resolutions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'supersede',
      id,
      supersedesId,
      effectiveDate,
      motionId: motionId || undefined,
    }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Supersede failed: ${res.status}`);
}

export async function repealResolution(id: string): Promise<void> {
  const res = await fetch('/api/admin/resolutions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'repeal', id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Repeal failed: ${res.status}`);
}

// ---------- Elections ----------
// GET already returns every election's full detail (drafts included, no tier
// filter, candidates and ballots nested — see fetchAdminElections), so like
// resolutions there is no separate single-election fetch: the list read IS
// the detail read.
export async function fetchElections(): Promise<ElectionDetail[]> {
  const res = await fetch('/api/admin/elections');
  if (!res.ok) throw new Error(`Load elections failed: ${res.status}`);
  return res.json();
}

export async function saveElection(
  data: ElectionInput,
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/elections', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Save election failed: ${res.status}`,
    );
}

export async function deleteElection(id: string): Promise<void> {
  const res = await fetch('/api/admin/elections', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
}

export async function closeElection(id: string): Promise<void> {
  const res = await fetch('/api/admin/elections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'close', id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Close failed: ${res.status}`);
}

export async function voidElection(id: string): Promise<void> {
  const res = await fetch('/api/admin/elections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'void', id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Void failed: ${res.status}`);
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
  const res = await fetch('/api/admin/elections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'certify', id, winners }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Certify failed: ${res.status}`);
}

export async function uncertifyElection(id: string): Promise<void> {
  const res = await fetch('/api/admin/elections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'uncertify', id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Uncertify failed: ${res.status}`);
}

export async function setTallies(
  electionId: string,
  entries: { candidateId: string; votes: number }[],
): Promise<void> {
  const res = await fetch('/api/admin/elections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setTallies', electionId, entries }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save tallies failed: ${res.status}`);
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
  const res = await fetch('/api/admin/elections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setBallots', electionId, entries }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Save ballots failed: ${res.status}`);
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
  const res = await fetch('/api/admin/candidates', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : { electionId, ...data }),
  });
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Save candidate failed: ${res.status}`,
    );
}

export async function deleteCandidate(id: string): Promise<void> {
  const res = await fetch('/api/admin/candidates', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Delete failed: ${res.status}`);
}
