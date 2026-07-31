// Report templates and shared report shapes. Client-safe (no server imports):
// the admin UI renders template cards from this list and the server resolves
// sub-queries from it.

export interface ReportTemplate {
  key: string;
  label: string;
  description: string;
  subQueries: string[]; // 3–6 hand-tuned retrieval queries
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: 'rentals',
    label: 'Rentals & leasing',
    description:
      'Leasing restrictions, lease terms, tenant rules, rental caps.',
    subQueries: [
      'leasing and rental restrictions',
      'minimum lease term requirements',
      'tenant approval and registration',
      'rental cap or limit on leased homes',
    ],
  },
  {
    key: 'improvements',
    label: 'Fences & improvements',
    description: 'Architectural control, fences, additions, exterior changes.',
    subQueries: [
      'architectural review committee approval requirements',
      'fence height material and placement rules',
      'exterior modifications and home additions',
      'sheds outbuildings and accessory structures',
    ],
  },
  {
    key: 'assessments',
    label: 'Assessments & collections',
    description: 'Dues, special assessments, liens, late fees, collections.',
    subQueries: [
      'annual assessment amount and due dates',
      'special assessment approval requirements',
      'late fees interest and collection procedures',
      'assessment liens and foreclosure',
    ],
  },
  {
    key: 'enforcement',
    label: 'Enforcement & fines',
    description: 'Violations, notice requirements, hearings, fines, remedies.',
    subQueries: [
      'covenant violation notice requirements',
      'fines and penalties for violations',
      'hearing and appeal process for violations',
      'board enforcement powers and remedies',
    ],
  },
  {
    key: 'meetings',
    label: 'Meetings & voting',
    description:
      'Annual meetings, quorum, proxies, board elections, voting rights.',
    subQueries: [
      'annual meeting notice and requirements',
      'quorum requirements for member meetings',
      'proxy and absentee voting rules',
      'board of directors election procedures',
    ],
  },
  {
    key: 'maintenance',
    label: 'Maintenance responsibilities',
    description: 'Owner vs association maintenance duties, common areas.',
    subQueries: [
      'homeowner maintenance responsibilities',
      'association maintenance of common areas',
      'lawn landscaping and yard upkeep requirements',
      'exterior home maintenance standards',
    ],
  },
];

// --- Shared shapes for the reports API and admin UI ---

export interface ReportSource {
  id: string;
  title: string;
  category: string;
}

export interface ReportListItem {
  id: string;
  topic: string;
  templateKey: string | null;
  createdAt: string; // ISO
  createdBy: string;
}

export interface ReportDetail extends ReportListItem {
  contentMd: string;
  sources: ReportSource[];
}
