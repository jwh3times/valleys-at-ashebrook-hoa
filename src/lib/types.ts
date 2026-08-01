// Shared data shapes for site content.

export type Visibility = 'public' | 'homeowner' | 'board';

export interface Announcement {
  id: string;
  title: string;
  body: string; // plain text / simple markdown-ish; rendered with line breaks
  /** ISO date string, e.g. "2026-06-28". */
  date: string;
  pinned?: boolean;
  visibility: Visibility;
}

export interface DocumentItem {
  id: string;
  title: string;
  category: string; // e.g. "Governing Documents", "Meetings", "Forms"
  /** ISO date the document was added/updated. */
  updatedAt: string;
  visibility: Visibility;
}

/** Board-only view of a document: DocumentItem plus its searchability status.
 * `ragStatus` is never included in the public `/api/content/documents` read. */
export interface AdminDocumentItem extends DocumentItem {
  ragStatus: 'ok' | 'unsupported' | null;
  filename: string;
}

export interface DupeMember {
  id: string;
  title: string;
  filename: string;
  category: string;
  visibility: Visibility;
  sizeBytes: number;
  uploadedAt: string; // ISO
  contentHash?: string | null;
  /** ISO timestamp the file was kept-verified by a board member, else null. */
  verifiedAt: string | null;
}

export interface DupeGroupView {
  members: DupeMember[];
  suggestedKeepId: string;
  reason?: string;
  matchKind?: 'exact' | 'near';
  contentHash?: string | null;
  sameTier?: boolean;
  autoResolvable?: boolean;
  recommendation?: string;
}

export interface DuplicatesView {
  exact: DupeGroupView[];
  near: DupeGroupView[];
  remaining: number;
}

export interface PaymentOption {
  label: string; // e.g. "PayPal", "Venmo", "Zelle", "Mail a check"
  details: string; // instructions / handle / address
  url?: string; // optional button link (e.g. https://paypal.me/...)
}

export interface DuesSettings {
  amount: string; // free text, e.g. "$250 / year"
  dueDate: string; // free text, e.g. "Due January 31 each year"
  notes: string; // any extra info (late fees, etc.)
  paymentOptions: PaymentOption[];
}

export interface SiteSettings {
  siteName: string;
  tagline: string;
  contactEmail: string; // public contact email (shown on contact page)
  welcomeHeading: string;
  welcomeBody: string;
  /** When true, the site presents as the official HOA site (dues/board surfaces on, disclaimer off). */
  officialMode: boolean;
  /** Footer "not affiliated" disclaimer (unofficial mode only); blank ⇒ built-in copy. */
  disclaimerText: string;
  /** /about page body; blank lines separate paragraphs; blank ⇒ built-in copy. */
  aboutBody: string;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: 'The Valleys at Ashebrook Residents',
  tagline: 'Welcome to our community',
  contactEmail: '',
  welcomeHeading: 'Welcome to the Valleys at Ashebrook',
  welcomeBody:
    'This is an independent, resident-run website for neighbors in The Valleys at Ashebrook. Here you can read the latest announcements, view the community calendar, and find documents.',
  officialMode: false,
  disclaimerText: '',
  aboutBody: '',
};

/**
 * Coerce a raw parsed settings blob into a complete SiteSettings.
 * Applies the legacy `hoaName` -> `siteName` fallback and a strict boolean for officialMode.
 */
export function normalizeSiteSettings(raw: unknown): SiteSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : fallback;
  const legacyName = typeof r.hoaName === 'string' ? r.hoaName : undefined;
  const name =
    typeof r.siteName === 'string' && r.siteName.trim()
      ? r.siteName
      : (legacyName ?? DEFAULT_SITE_SETTINGS.siteName);
  return {
    siteName: name,
    tagline: str(r.tagline, DEFAULT_SITE_SETTINGS.tagline),
    contactEmail: str(r.contactEmail, DEFAULT_SITE_SETTINGS.contactEmail),
    welcomeHeading: str(r.welcomeHeading, DEFAULT_SITE_SETTINGS.welcomeHeading),
    welcomeBody: str(r.welcomeBody, DEFAULT_SITE_SETTINGS.welcomeBody),
    officialMode: r.officialMode === true,
    disclaimerText: str(r.disclaimerText, DEFAULT_SITE_SETTINGS.disclaimerText),
    aboutBody: str(r.aboutBody, DEFAULT_SITE_SETTINGS.aboutBody),
  };
}

export const DEFAULT_DUES_SETTINGS: DuesSettings = {
  amount: 'Amount to be announced',
  dueDate: '',
  notes: '',
  paymentOptions: [],
};

/**
 * Coerce a raw parsed dues blob into a complete DuesSettings: string fields,
 * a well-formed paymentOptions array, and payment urls restricted to http(s)
 * (the url is rendered as an <a href> in DuesInfo.tsx). Unknown keys are dropped.
 */
export function normalizeDuesSettings(raw: unknown): DuesSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : fallback;
  const rawOptions = Array.isArray(r.paymentOptions) ? r.paymentOptions : [];
  const paymentOptions: PaymentOption[] = rawOptions.map((o) => {
    const opt = (o && typeof o === 'object' ? o : {}) as Record<
      string,
      unknown
    >;
    const option: PaymentOption = {
      label: str(opt.label, ''),
      details: str(opt.details, ''),
    };
    if (typeof opt.url === 'string') {
      try {
        const u = new URL(opt.url);
        if (u.protocol === 'http:' || u.protocol === 'https:')
          option.url = opt.url;
      } catch {
        /* drop unparseable url */
      }
    }
    return option;
  });
  return {
    amount: str(r.amount, DEFAULT_DUES_SETTINGS.amount),
    dueDate: str(r.dueDate, DEFAULT_DUES_SETTINGS.dueDate),
    notes: str(r.notes, DEFAULT_DUES_SETTINGS.notes),
    paymentOptions,
  };
}

export const DOCUMENT_CATEGORIES = [
  'Governing Documents',
  'Policies',
  'Forms',
  'FAQs & How-To',
  'Budgets',
  'Financial Reports',
  'Bank & Payments',
  'Taxes',
  'Contracts',
  'Insurance',
  'Meetings',
  'Member Correspondence',
  'Legal & Collections',
  'Maps & Deeds',
  'Maintenance & Work Orders',
  'Rosters & Contacts',
] as const;

export interface Property {
  id: string;
  address: string;
  unit: string | null;
  status: 'active' | 'inactive';
  notes: string | null;
}

export interface Owner {
  id: string;
  propertyId: string;
  fullName: string;
  phone: string | null; // E.164
  email: string | null;
  status: 'active' | 'inactive';
  notes: string | null;
}

export type PropertyWithOwners = Property & { owners: Owner[] };

export interface MemberUser {
  id: string;
  name: string;
  email: string;
  createdAt: string; // ISO
}

export interface ManualApprovalItem {
  id: string;
  userId: string;
  email: string | null;
  claimedAddress: string;
  reason: string;
  status: string;
  createdAt: string; // ISO
}

export interface MembersView {
  recent: MemberUser[];
  queue: ManualApprovalItem[];
}

export interface BoardPerson {
  id: string;
  fullName: string;
  userId: string | null;
}

export interface BoardTerm {
  id: string;
  personId: string;
  title: string | null;
  termStart: string;
  termEnd: string | null;
}

export interface BoardPersonWithTerms extends BoardPerson {
  terms: BoardTerm[];
}

export interface BoardPersonInput {
  fullName?: string;
  userId?: string | null;
}

export interface BoardTermInput {
  personId?: string;
  title?: string | null;
  termStart?: string;
  termEnd?: string | null;
}

// ---------- Admin write-input validation ----------
// The site/dues settings normalizers above coerce-and-default (they never reject).
// Board content writes instead validate loudly: trim, cap length, check enums,
// drop unknown keys, and reject (with a field message) when a required field is
// empty — creating content is not the fail-open read path.

/** Max lengths, in characters, for board-managed write fields. */
export const INPUT_LIMITS = {
  title: 200,
  body: 10_000,
  address: 300,
  unit: 100,
  fullName: 200,
  notes: 2_000,
  email: 320,
  phone: 32,
  category: 100,
  propertyId: 100,
  assistantQuestion: 2_000,
  reportTopic: 200,
  officeTitle: 100,
  userId: 100,
  personId: 100,
  motionText: 2_000,
  meetingLocation: 200,
  summaryMd: 20_000,
} as const;

export type InputResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

export interface AnnouncementInput {
  title?: string;
  body?: string;
  date?: string;
  pinned?: boolean;
  visibility?: Visibility;
}

export interface PropertyInput {
  address?: string;
  unit?: string | null;
  status?: 'active' | 'inactive';
  notes?: string | null;
}

export interface OwnerInput {
  propertyId?: string;
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  status?: 'active' | 'inactive';
  notes?: string | null;
}

type WriteMode = 'create' | 'patch';

const asRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

const fail = (error: string): InputResult<never> => ({ ok: false, error });

// A required ("core") string: must be present and non-empty on create; on patch
// it may be absent (not updated) but, if present, must still be non-empty.
function coreString(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  label: string,
  mode: WriteMode,
): InputResult<string | undefined> {
  if (!(key in raw))
    return mode === 'create'
      ? fail(`${label} is required`)
      : { ok: true, value: undefined };
  const s = (typeof raw[key] === 'string' ? (raw[key] as string) : '').trim();
  if (!s) return fail(`${label} is required`);
  if (s.length > max)
    return fail(`${label} must be ${max} characters or fewer`);
  return { ok: true, value: s };
}

// An optional, nullable string: absent → not updated; present → trimmed and
// capped, mapped to null when empty (matches the nullable DB columns).
function nullableString(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  label: string,
): InputResult<string | null | undefined> {
  if (!(key in raw)) return { ok: true, value: undefined };
  if (raw[key] === null) return { ok: true, value: null };
  const s = (typeof raw[key] === 'string' ? (raw[key] as string) : '').trim();
  if (s.length > max)
    return fail(`${label} must be ${max} characters or fewer`);
  return { ok: true, value: s === '' ? null : s };
}

function statusField(
  raw: Record<string, unknown>,
  key: string,
): InputResult<'active' | 'inactive' | undefined> {
  if (!(key in raw)) return { ok: true, value: undefined };
  const v = raw[key];
  if (v !== 'active' && v !== 'inactive')
    return fail('status must be active or inactive');
  return { ok: true, value: v };
}

function visibilityField(
  raw: Record<string, unknown>,
  key: string,
): InputResult<Visibility | undefined> {
  if (!(key in raw)) return { ok: true, value: undefined };
  const v = raw[key];
  if (v !== 'public' && v !== 'homeowner' && v !== 'board')
    return fail('visibility must be public, homeowner, or board');
  return { ok: true, value: v };
}

/** Required enum field. Absent on create fails; absent on patch is skipped. */
function enumField<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  mode: WriteMode,
): InputResult<T | undefined> {
  if (!(key in raw))
    return mode === 'create'
      ? fail(`${key} is required`)
      : { ok: true, value: undefined };
  const v = raw[key];
  if (typeof v !== 'string' || !allowed.includes(v as T))
    return fail(`${key} must be one of: ${allowed.join(', ')}`);
  return { ok: true, value: v as T };
}

/** Non-negative integer, or undefined when absent. Explicit null clears it. */
function nonNegativeInt(
  raw: Record<string, unknown>,
  key: string,
): InputResult<number | null | undefined> {
  if (!(key in raw)) return { ok: true, value: undefined };
  if (raw[key] === null) return { ok: true, value: null };
  const n = raw[key];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0)
    return fail(`${key} must be a non-negative whole number`);
  return { ok: true, value: n };
}

function isoDate(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  mode: WriteMode,
): InputResult<string | undefined> {
  if (!(key in raw))
    return mode === 'create'
      ? fail(`${label} is required`)
      : { ok: true, value: undefined };
  const s = (typeof raw[key] === 'string' ? (raw[key] as string) : '').trim();
  if (!s) return fail(`${label} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    return fail(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
    return fail(`${label} is not a valid calendar date`);
  return { ok: true, value: s };
}

/** Optional ISO date. Absent → undefined; explicit null or blank → null. */
function nullableIsoDate(
  raw: Record<string, unknown>,
  key: string,
  label: string,
): InputResult<string | null | undefined> {
  if (!(key in raw)) return { ok: true, value: undefined };
  if (raw[key] === null) return { ok: true, value: null };
  const s = (typeof raw[key] === 'string' ? (raw[key] as string) : '').trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    return fail(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
    return fail(`${label} is not a valid calendar date`);
  return { ok: true, value: s };
}

/**
 * Term ranges are validated in two places — the normalizer when a write
 * carries both ends, and the PATCH route after merging one end with the
 * stored row — so the rule lives in one exported function.
 * ISO YYYY-MM-DD strings compare correctly with `<`.
 */
export function termRangeError(
  start: string,
  end: string | null,
): string | null {
  if (end === null) return null;
  return end < start ? 'termEnd must not be before termStart' : null;
}

export function normalizeAnnouncementInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<AnnouncementInput> {
  const r = asRecord(raw);
  const out: AnnouncementInput = {};
  const title = coreString(r, 'title', INPUT_LIMITS.title, 'title', mode);
  if (!title.ok) return title;
  if (title.value !== undefined) out.title = title.value;
  const body = coreString(r, 'body', INPUT_LIMITS.body, 'body', mode);
  if (!body.ok) return body;
  if (body.value !== undefined) out.body = body.value;
  const date = isoDate(r, 'date', 'date', mode);
  if (!date.ok) return date;
  if (date.value !== undefined) out.date = date.value;
  if ('pinned' in r) {
    if (typeof r.pinned !== 'boolean') return fail('pinned must be a boolean');
    out.pinned = r.pinned;
  }
  const visibility = visibilityField(r, 'visibility');
  if (!visibility.ok) return visibility;
  if (visibility.value !== undefined) out.visibility = visibility.value;
  return { ok: true, value: out };
}

export function normalizePropertyInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<PropertyInput> {
  const r = asRecord(raw);
  const out: PropertyInput = {};
  const address = coreString(
    r,
    'address',
    INPUT_LIMITS.address,
    'address',
    mode,
  );
  if (!address.ok) return address;
  if (address.value !== undefined) out.address = address.value;
  const unit = nullableString(r, 'unit', INPUT_LIMITS.unit, 'unit');
  if (!unit.ok) return unit;
  if (unit.value !== undefined) out.unit = unit.value;
  const notes = nullableString(r, 'notes', INPUT_LIMITS.notes, 'notes');
  if (!notes.ok) return notes;
  if (notes.value !== undefined) out.notes = notes.value;
  const status = statusField(r, 'status');
  if (!status.ok) return status;
  if (status.value !== undefined) out.status = status.value;
  return { ok: true, value: out };
}

export function normalizeOwnerInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<OwnerInput> {
  const r = asRecord(raw);
  const out: OwnerInput = {};
  const propertyId = coreString(
    r,
    'propertyId',
    INPUT_LIMITS.propertyId,
    'propertyId',
    mode,
  );
  if (!propertyId.ok) return propertyId;
  if (propertyId.value !== undefined) out.propertyId = propertyId.value;
  const fullName = coreString(
    r,
    'fullName',
    INPUT_LIMITS.fullName,
    'fullName',
    mode,
  );
  if (!fullName.ok) return fullName;
  if (fullName.value !== undefined) out.fullName = fullName.value;
  const phone = nullableString(r, 'phone', INPUT_LIMITS.phone, 'phone');
  if (!phone.ok) return phone;
  if (phone.value !== undefined) out.phone = phone.value;
  const email = nullableString(r, 'email', INPUT_LIMITS.email, 'email');
  if (!email.ok) return email;
  if (email.value !== undefined) out.email = email.value;
  const status = statusField(r, 'status');
  if (!status.ok) return status;
  if (status.value !== undefined) out.status = status.value;
  return { ok: true, value: out };
}

export function normalizeBoardPersonInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<BoardPersonInput> {
  const r = asRecord(raw);
  const out: BoardPersonInput = {};
  const fullName = coreString(
    r,
    'fullName',
    INPUT_LIMITS.fullName,
    'fullName',
    mode,
  );
  if (!fullName.ok) return fullName;
  if (fullName.value !== undefined) out.fullName = fullName.value;
  const userId = nullableString(r, 'userId', INPUT_LIMITS.userId, 'userId');
  if (!userId.ok) return userId;
  if (userId.value !== undefined) out.userId = userId.value;
  return { ok: true, value: out };
}

export function normalizeBoardTermInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<BoardTermInput> {
  const r = asRecord(raw);
  const out: BoardTermInput = {};
  const personId = coreString(
    r,
    'personId',
    INPUT_LIMITS.personId,
    'personId',
    mode,
  );
  if (!personId.ok) return personId;
  if (personId.value !== undefined) out.personId = personId.value;
  const title = nullableString(r, 'title', INPUT_LIMITS.officeTitle, 'title');
  if (!title.ok) return title;
  if (title.value !== undefined) out.title = title.value;
  const termStart = isoDate(r, 'termStart', 'termStart', mode);
  if (!termStart.ok) return termStart;
  if (termStart.value !== undefined) out.termStart = termStart.value;
  const termEnd = nullableIsoDate(r, 'termEnd', 'termEnd');
  if (!termEnd.ok) return termEnd;
  if (termEnd.value !== undefined) out.termEnd = termEnd.value;
  // Only checkable here when the write carries both ends; a PATCH supplying
  // one end is re-checked against the stored row in the route.
  if (out.termStart !== undefined && out.termEnd !== undefined) {
    const err = termRangeError(out.termStart, out.termEnd);
    if (err) return fail(err);
  }
  return { ok: true, value: out };
}

export type MeetingBody = 'board' | 'member';
export type MeetingKind = 'regular' | 'special' | 'annual';
export type MeetingStatus = 'draft' | 'approved';
export type MotionOutcome = 'passed' | 'failed' | 'withdrawn' | 'tabled';
export type VoteChoice = 'yes' | 'no' | 'abstain' | 'recused' | 'absent';

export const MEETING_BODIES = ['board', 'member'] as const;
export const MEETING_KINDS = ['regular', 'special', 'annual'] as const;
export const MOTION_OUTCOMES = [
  'passed',
  'failed',
  'withdrawn',
  'tabled',
] as const;
export const VOTE_CHOICES = [
  'yes',
  'no',
  'abstain',
  'recused',
  'absent',
] as const;

export interface Tally {
  yes: number;
  no: number;
  abstain: number;
  recused: number;
  absent: number;
  /** False when no roll call was entered — never render a 0–0 tally instead. */
  recorded: boolean;
}

export interface VoteRow {
  personId: string;
  fullName: string;
  choice: VoteChoice;
}
export interface AttendanceRow {
  personId: string;
  fullName: string;
  present: boolean;
}

export type MemberVoteChoice = 'yes' | 'no' | 'abstain';
export const MEMBER_VOTE_CHOICES = ['yes', 'no', 'abstain'] as const;

export interface MemberAttendanceRow {
  propertyId: string;
  address: string;
  present: boolean;
  weight: number;
  representedByName: string | null;
  viaProxy: boolean;
}

export interface MemberVoteRow {
  propertyId: string;
  address: string;
  choice: MemberVoteChoice;
  weight: number;
  castByName: string | null;
  viaProxy: boolean;
}

export interface MotionDetail {
  id: string;
  sequence: number;
  text: string;
  moverName: string | null;
  secondName: string | null;
  outcome: MotionOutcome;
  tally: Tally;
  /** Board roll call. Populated when the parent meeting's body is 'board'. */
  votes: VoteRow[];
  /** Per-property votes. Populated when the parent meeting's body is 'member'. */
  memberVotes: MemberVoteRow[];
  /** Weighted tally over memberVotes; `recorded` false when none exist. */
  memberTally: Tally;
}
export interface MeetingSummary {
  id: string;
  body: MeetingBody;
  kind: MeetingKind;
  date: string;
  title: string;
  status: MeetingStatus;
  visibility: Visibility;
  motionCount: number;
}
export interface MeetingDetail extends MeetingSummary {
  startTime: string | null;
  location: string | null;
  summaryMd: string | null;
  documentId: string | null;
  quorumRequired: number | null;
  attendance: AttendanceRow[];
  memberAttendance: MemberAttendanceRow[];
  /**
   * Summed vote_weight of every ACTIVE property, the denominator for member
   * quorum. Zero for a board meeting, where quorum counts people.
   */
  totalActiveWeight: number;
  motions: MotionDetail[];
}

export interface MeetingInput {
  body?: MeetingBody;
  kind?: MeetingKind;
  date?: string;
  title?: string;
  startTime?: string | null;
  location?: string | null;
  summaryMd?: string | null;
  documentId?: string | null;
  quorumRequired?: number | null;
  visibility?: Visibility;
}
export interface MotionInput {
  meetingId?: string;
  text?: string;
  moverPersonId?: string | null;
  secondPersonId?: string | null;
  outcome?: MotionOutcome;
}

/**
 * Derive a tally from a roll call. Weight defaults to 1, so board votes (which
 * carry none) count exactly as before, while member votes sum their per-property
 * weight. There is deliberately no unweighted mode — SUM(weight) equals
 * COUNT(*) when every weight is 1.
 *
 * `recorded` tracks whether any roll call exists at all, independent of the
 * weights: a zero-weight vote was still cast, and a motion with no roll call
 * must never render as a 0–0 tally.
 */
export function tallyVotes(
  votes: { choice: VoteChoice; weight?: number }[],
): Tally {
  const t: Tally = {
    yes: 0,
    no: 0,
    abstain: 0,
    recused: 0,
    absent: 0,
    recorded: votes.length > 0,
  };
  for (const v of votes) t[v.choice] += v.weight ?? 1;
  return t;
}

export function normalizeMeetingInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<MeetingInput> {
  const r = asRecord(raw);
  const out: MeetingInput = {};
  // Status is transition-only: approve/unapprove are explicit actions so the
  // approval provenance columns are always written together with the flip.
  if ('status' in r)
    return fail('status is not editable — use the approve or unapprove action');

  const body = enumField(r, 'body', MEETING_BODIES, mode);
  if (!body.ok) return body;
  if (body.value !== undefined) out.body = body.value;

  const kind = enumField(r, 'kind', MEETING_KINDS, mode);
  if (!kind.ok) return kind;
  if (kind.value !== undefined) out.kind = kind.value;

  const date = isoDate(r, 'date', 'date', mode);
  if (!date.ok) return date;
  if (date.value !== undefined) out.date = date.value;

  const title = coreString(r, 'title', INPUT_LIMITS.title, 'title', mode);
  if (!title.ok) return title;
  if (title.value !== undefined) out.title = title.value;

  const startTime = nullableString(r, 'startTime', 20, 'startTime');
  if (!startTime.ok) return startTime;
  if (startTime.value !== undefined) out.startTime = startTime.value;

  const location = nullableString(
    r,
    'location',
    INPUT_LIMITS.meetingLocation,
    'location',
  );
  if (!location.ok) return location;
  if (location.value !== undefined) out.location = location.value;

  const summaryMd = nullableString(
    r,
    'summaryMd',
    INPUT_LIMITS.summaryMd,
    'summaryMd',
  );
  if (!summaryMd.ok) return summaryMd;
  if (summaryMd.value !== undefined) out.summaryMd = summaryMd.value;

  const documentId = nullableString(
    r,
    'documentId',
    INPUT_LIMITS.propertyId,
    'documentId',
  );
  if (!documentId.ok) return documentId;
  if (documentId.value !== undefined) out.documentId = documentId.value;

  const quorum = nonNegativeInt(r, 'quorumRequired');
  if (!quorum.ok) return quorum;
  if (quorum.value !== undefined) out.quorumRequired = quorum.value;

  const visibility = visibilityField(r, 'visibility');
  if (!visibility.ok) return visibility;
  if (visibility.value !== undefined) out.visibility = visibility.value;

  return { ok: true, value: out };
}

export function normalizeMotionInput(
  raw: unknown,
  mode: WriteMode,
): InputResult<MotionInput> {
  const r = asRecord(raw);
  const out: MotionInput = {};
  // The server assigns sequence as max + 1 on create; there is no reorder
  // action, so a gap left by deleting a motion (e.g. 1, 3 after deleting 2)
  // is not backfilled. Accepting sequence here would let a client create
  // duplicate positions, so it stays server-only.
  if ('sequence' in r)
    return fail('sequence is not editable — the server assigns it');

  const meetingId = coreString(
    r,
    'meetingId',
    INPUT_LIMITS.propertyId,
    'meetingId',
    mode,
  );
  if (!meetingId.ok) return meetingId;
  if (meetingId.value !== undefined) out.meetingId = meetingId.value;

  const text = coreString(r, 'text', INPUT_LIMITS.motionText, 'text', mode);
  if (!text.ok) return text;
  if (text.value !== undefined) out.text = text.value;

  const mover = nullableString(
    r,
    'moverPersonId',
    INPUT_LIMITS.propertyId,
    'moverPersonId',
  );
  if (!mover.ok) return mover;
  if (mover.value !== undefined) out.moverPersonId = mover.value;

  const second = nullableString(
    r,
    'secondPersonId',
    INPUT_LIMITS.propertyId,
    'secondPersonId',
  );
  if (!second.ok) return second;
  if (second.value !== undefined) out.secondPersonId = second.value;

  const outcome = enumField(r, 'outcome', MOTION_OUTCOMES, mode);
  if (!outcome.ok) return outcome;
  if (outcome.value !== undefined) out.outcome = outcome.value;

  return { ok: true, value: out };
}

/**
 * Vote weight on a property. Positive integer only — zero is rejected because
 * a property that should not vote belongs at status 'inactive', not weight 0,
 * and a silent zero would distort quorum denominators without appearing in any
 * list. Absent means "leave unchanged"; null is refused because the column is
 * NOT NULL with a default and has no cleared state.
 */
export function normalizeVoteWeight(
  raw: unknown,
): InputResult<number | undefined> {
  const r = asRecord(raw);
  if (!('voteWeight' in r)) return { ok: true, value: undefined };
  const v = r.voteWeight;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    return fail('voteWeight must be a whole number of 1 or more');
  return { ok: true, value: v };
}
