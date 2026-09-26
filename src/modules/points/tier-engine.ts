/**
 * Which tier a member holds, given what they have earned.
 *
 * Pure and configuration-driven on purpose. The actual thresholds are VOO-4's to decide
 * and are not known yet; the rule that turns points into a tier is not waiting on them,
 * so it is written and tested here against arbitrary scales and seeded with real numbers
 * later. If VOO-4 slips, this is still finished.
 */

export interface TierDefinition {
  /** Stable key used in code and on the pass. */
  code: string;
  /** What the member is shown, in the clinic's language. */
  label: string;
  /** Inclusive floor, in LIFETIME points earned. */
  minLifetimePoints: number;
}

/**
 * Orders a scale from lowest floor to highest, and rejects one that cannot be evaluated.
 *
 * Two scales are unusable rather than merely odd, and both are far cheaper to catch here
 * than to discover from a member holding the wrong tier:
 *
 * - Two tiers sharing a floor. Which one a member holds would depend on array order.
 * - Two tiers sharing a code. The pass would show whichever was found first.
 */
export const normaliseScale = (tiers: readonly TierDefinition[]): TierDefinition[] => {
  const sorted = [...tiers].sort((a, b) => a.minLifetimePoints - b.minLifetimePoints);

  const floors = new Set<number>();
  const codes = new Set<string>();

  for (const tier of sorted) {
    if (floors.has(tier.minLifetimePoints)) {
      throw new Error(
        `tier scale is ambiguous: two tiers start at ${tier.minLifetimePoints} lifetime points`
      );
    }

    if (codes.has(tier.code)) {
      throw new Error(`tier scale is ambiguous: "${tier.code}" is defined twice`);
    }

    floors.add(tier.minLifetimePoints);
    codes.add(tier.code);
  }

  return sorted;
};

/**
 * The highest tier whose floor the member has reached, or null if they have reached none.
 *
 * Null rather than an invented bottom tier: a scale that does not start at zero is a
 * configuration choice, and inventing a "no tier" entry here would put a label on the
 * member's pass that the clinic never wrote.
 */
export const tierFor = (
  lifetimePoints: number,
  tiers: readonly TierDefinition[]
): TierDefinition | null => {
  const scale = normaliseScale(tiers);

  let held: TierDefinition | null = null;

  for (const tier of scale) {
    if (lifetimePoints >= tier.minLifetimePoints) {
      held = tier;
      continue;
    }

    break;
  }

  return held;
};

/**
 * How many points until the next tier, and which it is. Null once the top is reached.
 *
 * Exists because "340 points to Gold" is the single most motivating thing a loyalty card
 * can say, and computing it at the call site is how two surfaces end up disagreeing.
 */
export const nextTier = (
  lifetimePoints: number,
  tiers: readonly TierDefinition[]
): { tier: TierDefinition; pointsAway: number } | null => {
  const scale = normaliseScale(tiers);
  const next = scale.find((tier) => tier.minLifetimePoints > lifetimePoints);

  if (!next) return null;

  return { tier: next, pointsAway: next.minLifetimePoints - lifetimePoints };
};
