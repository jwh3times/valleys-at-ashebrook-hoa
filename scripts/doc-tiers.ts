import type { Visibility } from '../src/lib/types';

interface Rule {
  match: RegExp;
  visibility: Visibility;
  category: string;
}

// Order matters: board (most restricted) rules are checked first.
const RULES: Rule[] = [
  {
    match:
      /legal|collection|violation|enforcement|correspondence|bank statement|check image|invoice image|financials-board|financials-prelims|contract|tax return|transaction history|delinquen/i,
    visibility: 'board',
    category: 'Other',
  },
  {
    match:
      /minutes|meeting|budget|financial|insurance|assessment|collection policy|welcome letter/i,
    visibility: 'homeowner',
    category: 'Financials',
  },
  {
    match:
      /gov doc|governing|by-?law|covenant|articles of incorporation|plat|\bmaps?\b|resolution|owner faq|portal|arc form|architectural review form|forms?\b/i,
    visibility: 'public',
    category: 'Governing Documents',
  },
];

export function pathToDocMeta(relPath: string): {
  visibility: Visibility;
  category: string;
} {
  for (const rule of RULES) {
    if (rule.match.test(relPath))
      return { visibility: rule.visibility, category: rule.category };
  }
  return { visibility: 'board', category: 'Other' };
}
