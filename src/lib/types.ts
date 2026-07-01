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
  hoaName: string;
  tagline: string;
  contactEmail: string; // HOA Gmail (shown on contact page)
  welcomeHeading: string;
  welcomeBody: string;
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  hoaName: 'Valleys at Ashebrook HOA',
  tagline: 'Welcome to our community',
  contactEmail: '',
  welcomeHeading: 'Welcome to the Valleys at Ashebrook',
  welcomeBody:
    'This is the official website for our homeowners association. Here you can read the latest announcements, view the community calendar, find governing documents, learn how to pay your annual dues, and contact the board.',
};

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
