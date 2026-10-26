// The shape of a Tenancy invitation token (#294 slice 4): 32 random bytes,
// base64url without padding. Shared by the claim, which refuses anything else
// before hashing, and by the sign-in return path, which honours only an
// invitation link.

export const INVITATION_TOKEN_PATTERN = '[A-Za-z0-9_-]{43}';

const WHOLE_TOKEN = new RegExp(`^${INVITATION_TOKEN_PATTERN}$`);

export function isInvitationToken(token: string): boolean {
  return WHOLE_TOKEN.test(token);
}
