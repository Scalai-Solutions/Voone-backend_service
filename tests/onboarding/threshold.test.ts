import { describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("./reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import { realThresholds, run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import {
  moveMilestone,
  spendRange,
  THRESHOLD_REFUSALS
} from "../../src/modules/onboarding/threshold";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * Moving the spend at which a reward unlocks. The admin types euros PAID; the ladder stores
 * progress, which runs faster from Oro up. What she types must be what the screen then shows, the
 * reward must stay between its neighbours, and nothing else on the ladder may move.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const fresh = (): Program => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

const moved = (p: Program, n: number, real: number): Program => {
  const result = moveMilestone(p, n, real);

  if (!result.ok) throw new Error(result.reason);

  return result.program;
};

const rewardsIn = (p: Program, tramo: number) =>
  p.lad.ms.filter((m) => m.type === "premio" && m.tramo === tramo).map((m) => m.n);
const shownSpend = (p: Program, n: number): number =>
  presentProgram(p).ladder.find((m) => m.n === n)!.realSpend;

describe("moving a reward's spend", () => {
  it("moves the reward to exactly the amount typed, in every tier band", () => {
    const p = fresh();

    for (const tramo of [1, 2, 3, 4]) {
      for (const n of rewardsIn(p, tramo)) {
        const range = spendRange(p, n)!;

        expect(range, `milestone ${n}`).not.toBeNull();

        // Every amount the admin may type, not a sample: rounding is where it would go wrong.
        for (let real = range.min; real <= range.max; real += 1) {
          expect(shownSpend(moved(p, n, real), n), `milestone ${n} at ${real}`).toBe(real);
        }
      }
    }
  });

  it("keeps the ladder in order and moves no other row's spend", () => {
    const p = fresh();
    const n = rewardsIn(p, 3)[0];
    const range = spendRange(p, n)!;

    for (const real of [range.min, range.max]) {
      const next = moved(p, n, real);
      const ths = next.lad.ms.map((m) => m.th);

      expect(ths.every((th, i) => i === 0 || th > ths[i - 1])).toBe(true);

      for (const m of p.lad.ms.filter((x) => x.n !== n)) {
        expect(next.lad.ms.find((x) => x.n === m.n)!.th).toBe(m.th);
        expect(next.realTh[m.n]).toBeCloseTo(p.realTh[m.n], 9);
      }

      expect(next.diamondReal).toBeCloseTo(p.diamondReal, 9);
    }
  });

  it("keeps the reward's own copy of the milestone, the real spends and the runtime in step", () => {
    const p = fresh();
    const n = rewardsIn(p, 1)[1];
    const range = spendRange(p, n)!;
    const next = moved(p, n, range.min);
    const th = next.lad.ms.find((m) => m.n === n)!.th;

    expect(next.chosen.find((c) => c.m.n === n)!.m.th).toBe(th);
    expect(next.realTh).toEqual(realThresholds(next.lad.ms));
    // A member is issued the reward at the new threshold.
    expect(programView(next).milestones.find((m) => m.n === n)!.th).toBe(th);
  });

  it("re-derives the cost share, which depends on the spend to Diamante", () => {
    const p = fresh();
    const n = rewardsIn(p, 2)[0];
    const next = moved(p, n, spendRange(p, n)!.max);

    expect(next.costPct).toBeCloseTo(next.totalCost / next.diamondReal, 10);
    expect(next.guarantees.some(([text]) => text.includes("cuestan el"))).toBe(true);
  });

  it("does not touch the programme it was given", () => {
    const p = fresh();
    const n = rewardsIn(p, 1)[0];
    const snapshot = JSON.stringify(p);

    moved(p, n, spendRange(p, n)!.min);

    expect(JSON.stringify(p)).toBe(snapshot);
  });
});

describe("what a move refuses", () => {
  it("refuses an amount outside the room between the neighbours, naming the limits", () => {
    const p = fresh();
    const n = rewardsIn(p, 3)[0];
    const range = spendRange(p, n)!;

    for (const real of [range.min - 1, range.max + 1]) {
      const result = moveMilestone(p, n, real);

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toContain("tiene que estar entre");
      expect(result.ok ? "" : result.reason).toContain(`${range.min.toLocaleString("es-ES")} €`);
      expect(result.ok ? "" : result.reason).toContain(`${range.max.toLocaleString("es-ES")} €`);
    }
  });

  it("refuses a perk, a tier step and a milestone that does not exist", () => {
    const p = fresh();
    const perk = p.lad.ms.find((m) => m.type === "ventaja")!.n;
    const level = p.lad.ms.find((m) => m.type === "nivel")!.n;

    for (const n of [perk, level, 999]) {
      expect(moveMilestone(p, n, 100)).toEqual({ ok: false, reason: THRESHOLD_REFUSALS.notReward });
      expect(spendRange(p, n)).toBeNull();
    }
  });

  it("refuses an amount that is not a whole number of euros above zero", () => {
    const p = fresh();
    const n = rewardsIn(p, 1)[0];

    for (const real of [0, -10, 12.5, Number.NaN]) {
      expect(moveMilestone(p, n, real)).toEqual({ ok: false, reason: THRESHOLD_REFUSALS.notWhole });
    }
  });
});

describe("the range on the admin's screen", () => {
  it("is the one the move enforces, on every reward, and only for the admin", () => {
    const p = fresh();
    const admin = presentProgram(p, { forAdmin: true }).ladder;

    for (const m of admin) {
      if (m.type === "premio") expect(m.spendRange).toEqual(spendRange(p, m.n));
      else expect(m).not.toHaveProperty("spendRange");
    }

    expect(presentProgram(p).ladder.some((m) => "spendRange" in m)).toBe(false);
  });

  it("contains the reward's current spend", () => {
    const p = fresh();

    for (const m of presentProgram(p, { forAdmin: true }).ladder) {
      if (m.spendRange) {
        expect(m.realSpend).toBeGreaterThanOrEqual(m.spendRange.min);
        expect(m.realSpend).toBeLessThanOrEqual(m.spendRange.max);
      }
    }
  });
});
