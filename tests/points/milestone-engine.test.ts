import { describe, expect, it } from "vitest";

import { milestoneProgress } from "../../src/modules/points/milestone-engine";

/** Bronze: five steps of 200, starting at zero. */
const BRONZE = { minLifetimePoints: 0, milestoneCount: 5, pointsToNextMilestone: 200 };
/** Diamond: ten steps of 3000, starting at 15,000. */
const DIAMOND = { minLifetimePoints: 15_000, milestoneCount: 10, pointsToNextMilestone: 3_000 };

describe("milestoneProgress", () => {
  it("starts a member at the bottom of the ladder", () => {
    expect(milestoneProgress(0, BRONZE)).toMatchObject({
      reached: 0,
      total: 5,
      pointsToNext: 200,
      progressPercent: 0,
      complete: false
    });
  });

  it("counts a completed step", () => {
    expect(milestoneProgress(200, BRONZE)).toMatchObject({ reached: 1, pointsToNext: 200 });
  });

  it("reports how far through the CURRENT step, not through the tier", () => {
    // The pass shows this next to "próxima recompensa", so it has to answer "how close
    // is the next reward" — a member four steps into five is 0% toward the fifth, not
    // 80% done.
    expect(milestoneProgress(850, BRONZE)).toMatchObject({
      reached: 4,
      pointsToNext: 150,
      progressPercent: 25
    });
  });

  it("measures from the TIER's floor, not from zero", () => {
    // The reason milestones belong to a tier. A member freshly promoted to Diamond is
    // at the start of Diamond's ladder, not five steps into it.
    expect(milestoneProgress(15_000, DIAMOND)).toMatchObject({
      reached: 0,
      pointsToNext: 3_000,
      progressPercent: 0
    });
  });

  it("gives each tier its own rhythm", () => {
    // 1,500 points into the tier: seven and a half Bronze steps, half a Diamond step.
    expect(milestoneProgress(1_500, BRONZE).reached).toBe(5);
    expect(milestoneProgress(16_500, DIAMOND)).toMatchObject({
      reached: 0,
      progressPercent: 50
    });
  });

  it("stops at the top of the ladder rather than counting past it", () => {
    const done = milestoneProgress(10_000, BRONZE);

    expect(done).toMatchObject({ reached: 5, total: 5, complete: true });
    // Zero rather than the distance to a step that does not exist.
    expect(done.pointsToNext).toBe(0);
    // 100 so the bar reads as finished rather than as freshly reset to empty.
    expect(done.progressPercent).toBe(100);
  });

  it("treats a member below the tier's floor as at the start", () => {
    // Only reachable by passing a tier the member has not reached. Negative progress
    // would surface as a nonsensical percentage on a real card.
    expect(milestoneProgress(0, DIAMOND)).toMatchObject({
      reached: 0,
      progressPercent: 0,
      complete: false
    });
  });

  it("handles a tier with no milestones as already complete", () => {
    const none = milestoneProgress(500, { ...BRONZE, milestoneCount: 0 });

    expect(none).toMatchObject({ reached: 0, total: 0, complete: true, pointsToNext: 0 });
  });

  it("never divides by zero on a malformed spacing", () => {
    // The schema forbids it, but this is arithmetic a card depends on.
    expect(() => milestoneProgress(500, { ...BRONZE, pointsToNextMilestone: 0 })).not.toThrow();
    expect(milestoneProgress(500, { ...BRONZE, pointsToNextMilestone: 0 }).total).toBe(5);
  });

  it("rounds the percentage, because it renders as one", () => {
    const progress = milestoneProgress(100, { ...BRONZE, pointsToNextMilestone: 300 });

    expect(Number.isInteger(progress.progressPercent)).toBe(true);
    expect(progress.progressPercent).toBe(33);
  });
});
