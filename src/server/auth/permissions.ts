import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

const statement = {
  ...defaultStatements,
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
} as const;

export const ac = createAccessControl(statement);

export const visitor = ac.newRole({});
export const homeowner = ac.newRole({});
// Board holds no Better Auth admin-plugin capabilities: all role changes are
// direct DB writes (see api/admin/roles.ts, members.ts), so impersonation/ban/
// set-role are intentionally NOT granted. The custom statements below document
// intent; enforcement of board-only routes is rank-based in requireBoard.
export const board = ac.newRole({
  roster: ['read', 'write'],
  member: ['read', 'revoke'],
  role: ['grant'],
});
