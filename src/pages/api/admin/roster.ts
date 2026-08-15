import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { fetchAdminRoster } from '../../../server/roster/reads';
import { associationDateIso } from '../../../lib/format';

// ADR 0022 phase 3b (#218): the board's Roster surface — Lots, Parties,
// Ownerships, Representations, and Contact Methods in one full-detail read,
// with the Ownerless-Lot advisory derived live (#205: a paperwork gap, not an
// incident — no Review Flag, no email). Contact values appear because this is
// a board-and-above read; redacted identities come pre-rendered through the
// shared durable-ID fallback. This is a READ; every mutation goes through the
// per-entity action routes beside it (roster-lots, roster-parties,
// roster-ownerships, roster-representations, roster-contact-methods).
//
// Deliberately writes NO Access Event: single-record and screen-level reads
// stay out of the ledger — the bulk export (roster-export.ts) is the one read
// that removes data from the system's control, and the only one recorded.

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminRoster(env, associationDateIso()));
};
