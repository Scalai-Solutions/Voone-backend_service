import { describe, expect, it } from "vitest";

import {
  nextTier,
  normaliseScale,
  tierFor,
  type TierDefinition
} from "../../src/modules/points/tier-engine";

/**
 * Arbitrary numbers on purpose. The real scale is VOO-4's to decide and is not known
 * yet; the rule that turns points into a tier does not depend on it, and writing these
 * against invented thresholds is what keeps the engine finished if VOO-4 slips.
 */
const SCALE: TierDefinition[] = [
  { code: "bronze", label: "Bronce", minLifetimePoints: 0 },
  { code: "silver", label: "Plata", minLifetimePoints: 500 },
  { code: "gold", label: "Oro", minLifetimePoints: 2000 }
];

describe("tierFor", () => {
  it("gives the highest tier the member has reached", () => {
    expect(tierFor(2500, SCALE)?.code).toBe("gold");
  });

  it("treats a floor as inclusive, so reaching it counts", () => {
    expect(tierFor(500, SCALE)?.code).toBe("silver");
    expect(tierFor(499, SCALE)?.code).toBe("bronze");
  });

  it("does not care what order the scale arrives in", () => {
    const shuffled = [SCALE[2], SCALE[0], SCALE[1]];

    expect(tierFor(600, shuffled)?.code).toBe("silver");
  });

  it("returns null when the member has reached no tier at all", () => {
    // A scale that does not start at zero is a configuration choice. Inventing a bottom
    // tier here would put a label on the pass that the clinic never wrote.
    const noFloor = SCALE.filter((tier) => tier.minLifetimePoints > 0);

    expect(tierFor(10, noFloor)).toBeNull();
  });

  it("returns null for an empty scale rather than throwing", () => {
    expect(tierFor(5000, [])).toBeNull();
  });

  it("holds the top tier however far past it the member goes", () => {
    expect(tierFor(10_000_000, SCALE)?.code).toBe("gold");
  });
});

describe("tier is driven by lifetime points, never by the spendable balance", () => {
  it("does not demote a member who spends what they earned", () => {
    // The decision this encodes: redeeming a reward must not cost you your tier. With a
    // single counter it would, and the programme would punish the behaviour it exists to
    // encourage.
    const lifetime = 2100;
    const spendableAfterRedeeming = 100;

    expect(tierFor(lifetime, SCALE)?.code).toBe("gold");
    expect(tierFor(spendableAfterRedeeming, SCALE)?.code).toBe("bronze");
  });
});

describe("normaliseScale", () => {
  it("rejects two tiers starting at the same points", () => {
    // Which one a member holds would otherwise depend on array order.
    const ambiguous = [...SCALE, { code: "platinum", label: "Platino", minLifetimePoints: 2000 }];

    expect(() => normaliseScale(ambiguous)).toThrow(/ambiguous/);
  });

  it("rejects a repeated code", () => {
    const ambiguous = [...SCALE, { code: "gold", label: "Oro VIP", minLifetimePoints: 5000 }];

    expect(() => normaliseScale(ambiguous)).toThrow(/"gold"/);
  });

  it("sorts by floor", () => {
    expect(normaliseScale([SCALE[2], SCALE[0]]).map((t) => t.code)).toEqual(["bronze", "gold"]);
  });
});

describe("nextTier", () => {
  it("says which tier is next and how far away it is", () => {
    expect(nextTier(1660, SCALE)).toEqual({ tier: SCALE[2], pointsAway: 340 });
  });

  it("is null at the top, because there is nothing to chase", () => {
    expect(nextTier(2000, SCALE)).toBeNull();
  });

  it("counts from the member's position, not from the tier below", () => {
    expect(nextTier(0, SCALE)?.pointsAway).toBe(500);
    expect(nextTier(499, SCALE)?.pointsAway).toBe(1);
  });
});
