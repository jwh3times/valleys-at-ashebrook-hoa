import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleBootstrapBoard } from '../../../server/roster/bootstrap';

export const prerender = false;

// Permanent, fail-closed first-System-Administrator bootstrap (#219). The
// guard logic lives in handleBootstrapBoard so it's unit-testable with an
// injected env. This path is one of write-freeze.ts's two ALWAYS_LIVE
// exemptions — flip step 4 runs it while the operator write freeze is still
// on — so this route must never call writeFreezeError.
export const POST: APIRoute = ({ request }) =>
  handleBootstrapBoard(env, request);
