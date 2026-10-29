// Where sign-in and registration return to (#294 slice 4). A tenant who opens
// an invitation link while signed out is sent to sign in or register with the
// link as `next`. Only an invitation link is honoured — the exact path, one
// well-formed token, nothing else — so `next` can never become an open
// redirect or carry a visitor anywhere the site did not put it.

import { INVITATION_TOKEN_PATTERN } from './invitation-token';

const INVITATION_PATH = new RegExp(
  `^/tenant-invite\\?token=(${INVITATION_TOKEN_PATTERN})$`,
);

/** The invitation link named by `next` in `search`, or null. The link is
 * rebuilt from a constant prefix and the validated token, so the destination
 * never begins with anything the visitor supplied. */
export function invitationReturnPath(search: string): string | null {
  const next = new URLSearchParams(search).get('next');
  const token = next === null ? undefined : INVITATION_PATH.exec(next)?.[1];
  return token === undefined ? null : `/tenant-invite?token=${token}`;
}

/** The `?next=` query that carries the invitation named in `search` from
 * sign-in to registration and back, or empty when there is none. */
export function invitationNextQuery(search: string): string {
  const invitation = invitationReturnPath(search);
  return invitation ? `?next=${encodeURIComponent(invitation)}` : '';
}

/** Where to go after signing in: the invitation, else home. */
export function returnPathAfterSignIn(search: string): string {
  return invitationReturnPath(search) ?? '/';
}
