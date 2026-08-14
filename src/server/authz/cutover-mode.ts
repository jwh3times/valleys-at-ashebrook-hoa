import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { cutoverSettings } from '../db/cutover-schema';

/**
 * Which model answers authorization: the legacy `users.role` +
 * `user_property_links` pair, or the ADR 0022 derived capability set.
 *
 * This is the ADR 0022 phase-3 flip switch (#217). Until this module existed,
 * `cutover_mode` was a row nothing read — which meant the flip's entire abort
 * plan ("roll back to `legacy` while the freeze still holds") had nothing to act
 * on. Making the flag decide is what makes the flip reversible.
 *
 * Read UNCACHED on every authenticated request, for the same reason the write
 * freeze is: the operator flips this row mid-incident and it must take effect
 * within seconds, without a deploy. Reversing it must be equally fast — that is
 * the whole rollback story.
 *
 * FAIL-CLOSED means LEGACY here, and the polarity is worth stating because it is
 * the opposite of the write freeze's. The freeze falls back to "frozen" because
 * refusing is the restrictive answer. This falls back to `legacy` because
 * "restrictive" is not the axis — the axis is "which of two models do we trust",
 * and the safe answer is the one that has been serving production all along and
 * whose behavior is fully understood. Falling back to `derived` on a read error
 * would flip the site's authorization model as a side effect of a transient
 * database blip, which is the single worst outcome available here.
 *
 * An ABSENT row is not an error: it is the normal pre-flip state.
 */
export type CutoverMode = 'legacy' | 'derived';

export async function getCutoverMode(env: Env): Promise<CutoverMode> {
  try {
    const [row] = await getDb(env)
      .select({ value: cutoverSettings.value })
      .from(cutoverSettings)
      .where(eq(cutoverSettings.key, 'cutover_mode'));
    return row?.value === 'derived' ? 'derived' : 'legacy';
  } catch {
    return 'legacy';
  }
}
