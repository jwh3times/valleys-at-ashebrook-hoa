import type { Role } from '../authz/guards';
import type { Visibility } from '../../lib/types';

const VIS_RANK: Record<Visibility, number> = {
  public: 0,
  homeowner: 1,
  board: 2,
};
const ROLE_RANK: Record<Role, number> = { visitor: 0, homeowner: 1, board: 2 };

export function tierAllows(role: Role, visibility: Visibility): boolean {
  return (ROLE_RANK[role] ?? 0) >= VIS_RANK[visibility];
}

export function visibleTiers(role: Role): Visibility[] {
  const rank = ROLE_RANK[role] ?? 0;
  return (['public', 'homeowner', 'board'] as Visibility[]).filter(
    (v) => VIS_RANK[v] <= rank,
  );
}
