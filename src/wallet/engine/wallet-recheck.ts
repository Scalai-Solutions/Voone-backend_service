/**
 * How many times one change may chain a further sync after itself.
 *
 * A sync that finds the card moved under it asks for another; this is what stops a card
 * that keeps changing (a busy member, or a card field that is not deterministic and so
 * "changes" on every read) from chaining forever.
 */
export const MAX_RECHECKS = 3;

/**
 * The chain depth of the follow-up sync to enqueue, or null when none should be.
 *
 * `depth` is how many re-checks led to the sync that just ran (0 for an ordinary change).
 * Hitting the cap is logged once, by the one sync that hit it.
 */
export const nextRecheckDepth = (
  memberId: string,
  stale: boolean,
  depth: number
): number | null => {
  if (!stale) return null;

  if (depth >= MAX_RECHECKS) {
    console.warn(
      `[wallet] sync for member ${memberId} still changing after ${MAX_RECHECKS} re-checks`
    );
    return null;
  }

  return depth + 1;
};
