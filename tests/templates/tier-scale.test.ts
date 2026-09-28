import { describe, expect, it } from "vitest";

import { tierRewardsSchema } from "../../src/modules/templates/templates.schema";
import { nextTier, tierFor } from "../../src/modules/points/tier-engine";

/**
 * Tiers are authored by the clinic during onboarding and are what decides a member's
 * level. They used to carry only a name, so nothing could rank anybody — every card
 * showed no tier while the wizard appeared to have configured five.
 */
const scale = (tiers: unknown) => {
  const parsed = tierRewardsSchema.safeParse(tiers);

  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));

  return parsed.data.map((tier) => ({
    code: tier.name,
    label: tier.name,
    minLifetimePoints: tier.minLifetimePoints
  }));
};

describe("a clinic's authored tier scale", () => {
  it("ranks a member by the points the clinic chose", () => {
    const tiers = scale([
      { name: "Bronze", minLifetimePoints: 0 },
      { name: "Gold", minLifetimePoints: 3000 }
    ]);

    expect(tierFor(2999, tiers)?.code).toBe("Bronze");
    expect(tierFor(3000, tiers)?.code).toBe("Gold");
  });

  it("lets a clinic delete a tier and still rank correctly", () => {
    // The wizard allows add and remove, so a three-tier clinic is ordinary.
    const tiers = scale([
      { name: "Base", minLifetimePoints: 0 },
      { name: "VIP", minLifetimePoints: 5000 }
    ]);

    expect(tiers).toHaveLength(2);
    expect(tierFor(10_000, tiers)?.code).toBe("VIP");
  });

  it("rejects two tiers starting at the same points", () => {
    // Which one a member holds would otherwise depend on array order.
    expect(() =>
      scale([
        { name: "Gold", minLifetimePoints: 3000 },
        { name: "Platinum", minLifetimePoints: 3000 }
      ])
    ).toThrow(/3000/);
  });

  it("rejects a repeated name, whatever the casing", () => {
    expect(() =>
      scale([
        { name: "Gold", minLifetimePoints: 1000 },
        { name: "gold", minLifetimePoints: 2000 }
      ])
    ).toThrow(/repetido/);
  });

  it("defaults a tier to milestones of its own", () => {
    const parsed = tierRewardsSchema.parse([{ name: "Bronze" }]);

    expect(parsed[0].milestoneCount).toBeGreaterThan(0);
    expect(parsed[0].pointsToNextMilestone).toBeGreaterThan(0);
  });

  it("lets each tier set its own milestone rhythm", () => {
    // The reason milestones moved off the clinic: one ladder cannot give Bronze and
    // Diamond different steps.
    const parsed = tierRewardsSchema.parse([
      { name: "Bronze", minLifetimePoints: 0, milestoneCount: 5, pointsToNextMilestone: 200 },
      { name: "Diamond", minLifetimePoints: 15000, milestoneCount: 10, pointsToNextMilestone: 3000 }
    ]);

    expect(parsed[0].pointsToNextMilestone).toBe(200);
    expect(parsed[1].pointsToNextMilestone).toBe(3000);
  });

  it("tells a member how far the next tier is", () => {
    const tiers = scale([
      { name: "Bronze", minLifetimePoints: 0 },
      { name: "Silver", minLifetimePoints: 1000 }
    ]);

    expect(nextTier(660, tiers)).toEqual({ tier: tiers[1], pointsAway: 340 });
  });

  it("holds no tier when the clinic's lowest floor is above the member", () => {
    // A scale that does not start at zero is a choice the clinic is allowed to make.
    const tiers = scale([{ name: "VIP", minLifetimePoints: 5000 }]);

    expect(tierFor(100, tiers)).toBeNull();
  });

  it("treats an empty scale as no tiers rather than an error", () => {
    expect(tierFor(10_000, scale([]))).toBeNull();
  });
});
