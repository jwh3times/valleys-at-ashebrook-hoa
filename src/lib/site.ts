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

/** Name shown in titles + footer copyright: the org name in official mode, else the admin-set site name. */
export function displayName(s: ModeName): string {
  return s.officialMode ? OFFICIAL_ORG_NAME : s.siteName;
}

/** Full <title> string; "Home" gets no suffix separator. */
export function siteTitle(pageTitle: string, s: ModeName): string {
  const name = displayName(s);
  return pageTitle === 'Home' ? name : `${pageTitle} | ${name}`;
}
