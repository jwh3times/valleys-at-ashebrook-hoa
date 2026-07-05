// Central branding + site-mode presentation logic.
// Pure module (no server/runtime imports) so it is usable in .astro, React islands, and unit tests.
import type { SiteSettings } from './types';

export const SITE_NAME = 'The Valleys at Ashebrook Residents';
export const NEIGHBORHOOD = 'The Valleys at Ashebrook';
export const OFFICIAL_ORG_NAME = 'Valleys at Ashebrook HOA';

/** One-line disclaimer shown in the footer when official mode is off. */
export const DISCLAIMER_SHORT =
  `Not affiliated with, endorsed by, or operated by the ${OFFICIAL_ORG_NAME} or its board. ` +
  'An independent site built and maintained by a resident of the neighborhood.';

/** Paragraphs for the /about page. */
export const DISCLAIMER_LONG: string[] = [
  `This is an independent, resident-built information hub for neighbors in ${NEIGHBORHOOD}. ` +
    'It gathers announcements, a community calendar, and documents in one place.',
  `It is not affiliated with, endorsed by, or operated by the ${OFFICIAL_ORG_NAME} or its board, ` +
    'and the HOA does not own or control it.',
  'The site runs on a resident’s personal accounts and a personally owned domain, ' +
    'and is built and maintained by that resident on their own initiative.',
  'For official HOA business — dues, governing decisions, or disputes — please contact the ' +
    'HOA or its management company directly.',
  'To reach the resident who maintains this site, use the Contact page.',
];

interface NavLink {
  href: string;
  label: string;
}

const BASE_NAV: NavLink[] = [
  { href: '/', label: 'Home' },
  { href: '/announcements', label: 'Announcements' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/documents', label: 'Documents' },
  { href: '/dues', label: 'Dues' },
  { href: '/contact', label: 'Contact' },
];

type ModeName = Pick<SiteSettings, 'officialMode' | 'siteName'>;

/** Primary nav links; the Dues link only appears in official mode. */
export function navLinks(officialMode: boolean): NavLink[] {
  return officialMode ? BASE_NAV : BASE_NAV.filter((l) => l.href !== '/dues');
}

/** Header sub-brand tag. */
export function brandTag(officialMode: boolean): string {
  return officialMode ? 'Homeowners Association' : 'Residents';
}

/** Footer disclaimer text: the board-editable override, or the built-in copy when blank. */
export function disclaimer(s: Pick<SiteSettings, 'disclaimerText'>): string {
  return s.disclaimerText.trim() || DISCLAIMER_SHORT;
}

/**
 * /about page paragraphs: the board-editable override split on blank lines
 * (trimmed, empties dropped), or the built-in paragraphs when blank.
 */
export function aboutParagraphs(s: Pick<SiteSettings, 'aboutBody'>): string[] {
  const body = s.aboutBody.trim();
  if (!body) return DISCLAIMER_LONG;
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Minimal auth shape the header needs (structurally satisfied by AuthContext). */
export interface AccountNavAuth {
  role: 'visitor' | 'homeowner' | 'board';
  propertyIds: string[];
}

export interface AccountNav {
  signedIn: boolean;
  links: NavLink[];
}

/**
 * Account affordances for the public header, driven by the resolved caller:
 * anonymous → sign in / register; a signed-in user without a verified home →
 * verify property; a board member → the admin panel; a verified homeowner →
 * nothing extra (the header still shows a sign-out control when `signedIn`).
 */
export function accountNav(auth: AccountNavAuth | null): AccountNav {
  if (!auth)
    return {
      signedIn: false,
      links: [
        { href: '/login', label: 'Sign in' },
        { href: '/register', label: 'Register' },
      ],
    };
  if (auth.role === 'board')
    return { signedIn: true, links: [{ href: '/admin', label: 'Admin' }] };
  if (auth.propertyIds.length === 0)
    return {
      signedIn: true,
      links: [{ href: '/verify-property', label: 'Verify your property' }],
    };
  return { signedIn: true, links: [] };
}

/** Name shown in titles + footer copyright: the org name in official mode, else the fixed resident brand. */
export function displayName(s: ModeName): string {
  // Off-mode name is the fixed resident brand, NOT the stored siteName: a legacy
  // settings blob carries the old default hoaName ("Valleys at Ashebrook HOA"), which
  // must never surface in unofficial mode. siteName is not admin-editable, so the
  // constant is the source of truth here.
  return s.officialMode ? OFFICIAL_ORG_NAME : SITE_NAME;
}

/** Full <title> string; "Home" gets no suffix separator. */
export function siteTitle(pageTitle: string, s: ModeName): string {
  const name = displayName(s);
  return pageTitle === 'Home' ? name : `${pageTitle} | ${name}`;
}
