import { createAccessControl } from 'better-auth/plugins/access';

const statement = {
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
} as const;

export const ac = createAccessControl(statement);

export const visitor = ac.newRole({});
export const homeowner = ac.newRole({});
export const board = ac.newRole({
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
});
