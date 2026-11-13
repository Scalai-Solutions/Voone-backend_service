import { describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("./reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import { realThresholds, run } from "../../src/modules/onboarding/engine";
import { P } from "../../src/modules/onboarding/engine.config";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import {
  moveMilestone,
  setRecurringEvery,
  spendRange,
  THRESHOLD_REFUSALS
} from "../../src/modules/onboarding/threshold";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * Moving the spend at which a reward unlocks, or a tier begins. The admin types euros PAID; the
 * ladder stores progress, which runs faster from Oro up. What she types must be what the screen
 * then shows, the row must stay between its neighbours, and no other row's spend may move.
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
/** The rewards and perks of a band (its tier step has its own tests). */
const movableIn = (p: Program, tramo: number) =>
  p.lad.ms.filter((m) => m.type !== "nivel" && m.tramo === tramo).map((m) => m.n);
const shownSpend = (p: Program, n: number): number =>
  presentProgram(p).ladder.find((m) => m.n === n)!.realSpend;

describe("moving a reward's spend", () => {
  it("moves a reward or a perk to exactly the amount typed, in every tier band", () => {
    const p = fresh();

    for (const tramo of [1, 2, 3, 4]) {
      for (const n of movableIn(p, tramo)) {
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

  it("moves a perk like a reward", () => {
    const p = fresh();
    const perk = p.lad.ms.find((m) => m.type === "ventaja")!;
    const range = spendRange(p, perk.n)!;
    const next = moved(p, perk.n, range.min);

    expect(shownSpend(next, perk.n)).toBe(range.min);
    expect(next.lad.ms.find((m) => m.n === perk.n)!.perk).toEqual(perk.perk);
  });

  it("refuses a milestone that does not exist", () => {
    const p = fresh();

    expect(moveMilestone(p, 999, 100)).toEqual({ ok: false, reason: THRESHOLD_REFUSALS.notReward });
    expect(spendRange(p, 999)).toBeNull();
  });

  it("refuses an amount that is not a whole number of euros above zero", () => {
    const p = fresh();
    const n = rewardsIn(p, 1)[0];

    for (const real of [0, -10, 12.5, Number.NaN]) {
      expect(moveMilestone(p, n, real)).toEqual({ ok: false, reason: THRESHOLD_REFUSALS.notWhole });
    }
  });
});

describe("moving a tier step", () => {
  const stepsOf = (p: Program) => p.lad.ms.filter((m) => m.type === "nivel");
  /** The range's ends and a few amounts between them: every amount would be thousands of runs. */
  const amountsIn = ({ min, max }: { min: number; max: number }): number[] => [
    ...new Set([min, max, ...[0.25, 0.5, 0.75].map((f) => Math.round(min + (max - min) * f))])
  ];

  it("moves each of the four to exactly the amount typed, and no other row's spend moves", () => {
    const p = fresh();

    expect(stepsOf(p)).toHaveLength(4);

    for (const step of stepsOf(p)) {
      const range = spendRange(p, step.n)!;

      expect(range, `tier step ${step.n}`).not.toBeNull();

      for (const real of amountsIn(range)) {
        const next = moved(p, step.n, real);

        expect(shownSpend(next, step.n), `step ${step.n} at ${real}`).toBe(real);

        for (const m of p.lad.ms.filter((x) => x.n !== step.n)) {
          // Whole progress euros: what a row shows may move by a rounding, never more.
          expect(
            Math.abs(shownSpend(next, m.n) - shownSpend(p, m.n)),
            `row ${m.n} after step ${step.n} at ${real}`
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps the ladder in order, the tiers in their bands, and every copy of a threshold in step", () => {
    const p = fresh();

    for (const step of stepsOf(p)) {
      const range = spendRange(p, step.n)!;

      for (const real of [range.min, range.max]) {
        const next = moved(p, step.n, real);
        const ths = next.lad.ms.map((m) => m.th);

        expect(ths.every((th, i) => i === 0 || th > ths[i - 1])).toBe(true);
        expect(next.lad.ms.map((m) => [m.n, m.type, m.tramo])).toEqual(
          p.lad.ms.map((m) => [m.n, m.type, m.tramo])
        );

        for (const c of next.chosen) {
          expect(c.m.th).toBe(next.lad.ms.find((m) => m.n === c.m.n)!.th);
        }

        expect(next.lad.last.th).toBe(next.lad.ms[next.lad.ms.length - 1].th);
        expect(next.realTh).toEqual(realThresholds(next.lad.ms));
        expect(next.diamondReal).toBe(next.realTh[next.lad.last.n]);
        expect(next.costPct).toBeCloseTo(next.totalCost / next.diamondReal, 10);
      }
    }
  });

  it("moves the tier itself: where the runtime starts it and what the admin reads", () => {
    const p = fresh();
    const oro = stepsOf(p)[1];
    const range = spendRange(p, oro.n)!;
    const next = moved(p, oro.n, range.max);
    const th = next.lad.ms.find((m) => m.n === oro.n)!.th;

    expect(programView(next).tiers.find((t) => t.key === "oro")!.floor).toBe(th);
    expect(presentProgram(next).tiers.find((t) => t.key === "oro")!.threshold).toBe(range.max);
  });

  it("moves no other threshold for Plata, where Bronce and Plata earn alike", () => {
    const p = fresh();
    const plata = stepsOf(p)[0];
    const range = spendRange(p, plata.n)!;

    for (const real of [range.min, range.max]) {
      const next = moved(p, plata.n, real);

      for (const m of p.lad.ms.filter((x) => x.n !== plata.n)) {
        expect(next.lad.ms.find((x) => x.n === m.n)!.th).toBe(m.th);
      }
    }
  });

  it("lets Diamante go up to its typo guard, never below where it is", () => {
    const p = fresh();
    const diamante = stepsOf(p)[3];
    const range = spendRange(p, diamante.n)!;

    expect(range.max).toBe(
      Math.max(Math.floor(2 * P.maxYears * p.est.A), Math.round(p.realTh[diamante.n]))
    );
    expect(shownSpend(moved(p, diamante.n, range.max), diamante.n)).toBe(range.max);
  });

  it("refuses one euro past either end, naming the limits", () => {
    const p = fresh();

    for (const step of stepsOf(p)) {
      const range = spendRange(p, step.n)!;

      for (const real of [range.min - 1, range.max + 1]) {
        const result = moveMilestone(p, step.n, real);

        expect(result.ok, `step ${step.n} at ${real}`).toBe(false);
        expect(result.ok ? "" : result.reason).toContain("tiene que estar entre");
      }
    }
  });

  it("does not touch the programme it was given", () => {
    const p = fresh();
    const step = stepsOf(p)[2];
    const snapshot = JSON.stringify(p);

    moved(p, step.n, spendRange(p, step.n)!.min);

    expect(JSON.stringify(p)).toBe(snapshot);
  });
});

describe("the range on the admin's screen", () => {
  it("is the one the move enforces, on every row tier steps included, and only for the admin", () => {
    const p = fresh();
    const admin = presentProgram(p, { forAdmin: true }).ladder;

    for (const m of admin) expect(m.spendRange).toEqual(spendRange(p, m.n) ?? undefined);

    expect(admin.filter((m) => m.type === "nivel").every((m) => m.spendRange)).toBe(true);
    expect(presentProgram(p).ladder.some((m) => "spendRange" in m)).toBe(false);
  });

  it("contains the row's current spend", () => {
    const p = fresh();

    for (const m of presentProgram(p, { forAdmin: true }).ladder) {
      if (m.spendRange) {
        expect(m.realSpend).toBeGreaterThanOrEqual(m.spendRange.min);
        expect(m.realSpend).toBeLessThanOrEqual(m.spendRange.max);
      }
    }
  });
});

describe("how often the reward after Diamante comes round", () => {
  it("shows exactly the euros typed, and leaves the reward and the ladder alone", () => {
    const program = fresh();

    for (const typed of [1, 137, 300, 999]) {
      const result = setRecurringEvery(program, typed);

      if (!result.ok) throw new Error(result.reason);
      expect(presentProgram(result.program).recurring.every).toBe(typed);
      expect(result.program.rec.o).toEqual(program.rec.o);
      expect(result.program.lad).toEqual(program.lad);
    }
  });

  it("refuses an amount that is not a whole number of euros above 0", () => {
    for (const bad of [0, -5, 12.5]) {
      expect(setRecurringEvery(fresh(), bad)).toEqual({
        ok: false,
        reason: THRESHOLD_REFUSALS.notWhole
      });
    }
  });
});
