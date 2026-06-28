/**
 * Central configuration for the HOA website.
 *
 * Edit the values here to customize the site for your community — this is the
 * single source of truth for the association name, contact details, and the
 * dues options shown on the payment page. No coding knowledge required: change
 * the text between the quotes.
 */

export const site = {
  /** The full legal/display name of your homeowners association. */
  name: "Valleys at Ashebrook",
  /** Short name used in the navbar and tight spaces. */
  shortName: "Valleys at Ashebrook",
  /** One-line description used for the hero and SEO metadata. */
  tagline: "Your neighborhood, online. Stay informed and get involved.",
  /** Mailing address shown in the footer and contact page. */
  address: "1 Ashebrook Drive, Your City, ST 00000",
  /** Public contact email for the board. The contact form also delivers here. */
  email: "ashebrookhoa@gmail.com",
  /** Public phone number (optional — leave empty string to hide). */
  phone: "(555) 555-0123",
  /** Office / meeting hours blurb shown on the contact page. */
  hours: "Board meetings: 2nd Tuesday of each month, 7:00 PM at the clubhouse.",
} as const;

/**
 * Dues options presented on the /dues page. Amounts are in whole US dollars and
 * converted to cents for Stripe automatically. Add or remove entries to match
 * your assessment schedule.
 */
export type DuesOption = {
  id: string;
  label: string;
  description: string;
  amount: number; // US dollars
};

export const duesOptions: DuesOption[] = [
  {
    id: "annual",
    label: "Annual Dues",
    description: "Full-year assessment (January–December).",
    amount: 275,
  },
];

export const nav = [
  { href: "/", label: "Home" },
  { href: "/announcements", label: "Announcements" },
  { href: "/calendar", label: "Calendar" },
  { href: "/documents", label: "Documents" },
  { href: "/dues", label: "Pay Dues" },
  { href: "/contact", label: "Contact" },
];
