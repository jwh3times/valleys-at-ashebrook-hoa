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
  category: string; // e.g. "Governing Documents", "Meeting Minutes", "Forms"
  /** ISO date the document was added/updated. */
  updatedAt: string;
  visibility: Visibility;
}

export interface DupeMember {
  id: string;
  title: string;
  filename: string;
  category: string;
  visibility: Visibility;
  sizeBytes: number;
  uploadedAt: string; // ISO
}

export interface DupeGroupView {
  members: DupeMember[];
  suggestedKeepId: string;
  reason?: string;
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
  'Meeting Minutes',
  'Financials',
  'Forms',
  'Other',
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

function isoDate(
  raw: Record<string, unknown>,
  key: string,
  mode: WriteMode,
): InputResult<string | undefined> {
  if (!(key in raw))
    return mode === 'create'
      ? fail('date is required')
      : { ok: true, value: undefined };
  const s = (typeof raw[key] === 'string' ? (raw[key] as string) : '').trim();
  if (!s) return fail('date is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fail('date must be YYYY-MM-DD');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
    return fail('date is not a valid calendar date');
  return { ok: true, value: s };
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
  const date = isoDate(r, 'date', mode);
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
