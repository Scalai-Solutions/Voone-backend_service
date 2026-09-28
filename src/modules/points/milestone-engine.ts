/**
 * Where a member is within their tier's reward ladder.
 *
 * Milestones belong to a tier rather than to the clinic: Bronze might be five steps of
 * 200 while Diamond is ten of 3000. So progress is always measured from the floor of the
 * tier the member currently holds, not from zero — otherwise a member who has just been
 * promoted would appear to be nearly finished with their new tier.
 *
 * Pure, and takes the tier it is given. The caller decides which tier that is.
 */

export interface MilestoneTier {
  /** Inclusive floor of the tier, in lifetime points. */
  minLifetimePoints: number;
  /** How many reward steps this tier contains. */
  milestoneCount: number;
  /** Points between those steps. */
  pointsToNextMilestone: number;
}

export interface MilestoneProgress {
  /** Steps completed within this tier, never more than milestoneCount. */
  reached: number;
  /** milestoneCount, repeated so a caller can render "3 / 5" without the tier. */
  total: number;
  /** Points still needed for the next step. Zero once the tier's ladder is complete. */
  pointsToNext: number;
  /**
   * How far through the CURRENT step, 0-100.
   *
   * Not progress through the tier: the pass shows this next to "próxima recompensa",
   * so it has to answer "how close is the next reward", which is a different question
   * once a member is four steps into five.
   */
  progressPercent: number;
  /** True once every step in this tier has been reached. */
  complete: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const milestoneProgress = (
  lifetimePoints: number,
  tier: MilestoneTier
): MilestoneProgress => {
  const total = Math.max(0, Math.trunc(tier.milestoneCount));
  const step = Math.max(1, Math.trunc(tier.pointsToNextMilestone));

  // A member below the tier's floor is not in it. Treated as the start rather than as a
  // negative position, because the only way to get here is a caller passing a tier the
  // member has not reached, and inventing negative progress would surface as a
  // nonsensical percentage on a real card.
  const intoTier = Math.max(0, lifetimePoints - tier.minLifetimePoints);

  if (total === 0) {
    return { reached: 0, total: 0, pointsToNext: 0, progressPercent: 0, complete: true };
  }

  const reached = clamp(Math.floor(intoTier / step), 0, total);
  const complete = reached >= total;

  if (complete) {
    // The ladder is finished. Zero rather than the distance to a step that does not
    // exist, and 100 so the bar reads as done rather than as freshly reset.
    return { reached: total, total, pointsToNext: 0, progressPercent: 100, complete: true };
  }

  const intoStep = intoTier - reached * step;

  return {
    reached,
    total,
    pointsToNext: step - intoStep,
    // Rounded, because this renders as a percentage on a pass and a long decimal in a
    // change message would be noise.
    progressPercent: Math.round((intoStep / step) * 100),
    complete: false
  };
};
