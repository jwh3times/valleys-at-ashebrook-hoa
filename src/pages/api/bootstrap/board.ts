import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleBootstrapBoard } from '../../../server/auth/seed-board';

export const prerender = false;

// Permanent, fail-closed first-board bootstrap. The guard logic lives in
// handleBootstrapBoard so it's unit-testable with an injected env.
export const POST: APIRoute = ({ request }) =>
  handleBootstrapBoard(env, request);
