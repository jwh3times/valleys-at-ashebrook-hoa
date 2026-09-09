/**
 * The pathname a request will actually be ROUTED to, which is not always the
 * one on the URL.
 *
 * Astro decodes the pathname before matching a route, so `/api/%61dmin/roles`
 * reaches the `/api/admin/roles` handler. Anything that classifies a path —
 * the middleware namespace backstop, the write freeze's coverage classes — has
 * to ask its question of the same string Astro matched, or the classification
 * and the routing disagree and it is the classification that loses.
 *
 * Decoding is REPEATED until the result stops changing, because that is what
 * Astro does (`validateAndDecodePathname`, `astro/dist/core/util/pathname.js`):
 * a single `decodeURI` leaves `/api/%2561dmin/roles` as `/api/%61dmin/roles`,
 * which still routes to the admin handler while classifying as an unnamed
 * path — the same bypass one level deeper. Astro's own iteration cap is 10 and
 * it rejects anything deeper; matching the cap keeps the two in step, and a
 * path that hits it is not one Astro will route either.
 *
 * A malformed escape sequence throws in `decodeURI`. The partially decoded
 * value is then the honest answer: it is what Astro falls back to, and the
 * classification is only ever made more inclusive by stopping early.
 */
const MAX_DECODE_ITERATIONS = 10;

export function routedPathname(pathname: string): string {
  let current = pathname;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    let decoded: string;
    try {
      decoded = decodeURI(current);
    } catch {
      return current;
    }
    if (decoded === current) return current;
    current = decoded;
  }
  return current;
}
