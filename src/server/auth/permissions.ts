import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, adminAc } from 'better-auth/plugins/admin/access';

const statement = {
  ...defaultStatements,
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
} as const;

export const ac = createAccessControl(statement);

export const visitor = ac.newRole({});
export const homeowner = ac.newRole({});
export const board = ac.newRole({
  ...adminAc.statements,
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
});
