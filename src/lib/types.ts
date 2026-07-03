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
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: 'The Valleys at Ashebrook Residents',
  tagline: 'Welcome to our community',
  contactEmail: '',
  welcomeHeading: 'Welcome to the Valleys at Ashebrook',
  welcomeBody:
    'This is an independent, resident-run website for neighbors in The Valleys at Ashebrook. Here you can read the latest announcements, view the community calendar, and find documents.',
  officialMode: false,
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
  };
}

export const DEFAULT_DUES_SETTINGS: DuesSettings = {
  amount: 'Amount to be announced',
  dueDate: '',
  notes: '',
  paymentOptions: [],
};

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
