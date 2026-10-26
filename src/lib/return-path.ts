// Where sign-in and registration return to (#294 slice 4). A tenant who opens
// an invitation link while signed out is sent to sign in or register with the
// link as `next`. Only an invitation link is honoured — the exact path, one
// well-formed token, nothing else — so `next` can never become an open
// redirect or carry a visitor anywhere the site did not put it.

import { INVITATION_TOKEN_PATTERN } from './invitation-token';

const INVITATION_PATH = new RegExp(
  `^/tenant-invite\\?token=${INVITATION_TOKEN_PATTERN}$`,
);

/** The invitation link named by `next` in `search`, or null. */
export function invitationReturnPath(search: string): string | null {
  const next = new URLSearchParams(search).get('next');
  return next !== null && INVITATION_PATH.test(next) ? next : null;
}

/** Where to go after signing in: the invitation, else home. */
export function returnPathAfterSignIn(search: string): string {
  return invitationReturnPath(search) ?? '/';
}
