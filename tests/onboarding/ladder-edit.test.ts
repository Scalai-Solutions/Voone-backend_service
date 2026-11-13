import { describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("./reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import {
  bandRange,
  insertMilestone,
  LADDER_REFUSALS,
  removeMilestone
} from "../../src/modules/onboarding/ladder-edit";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { swapRewardToSpecial } from "../../src/modules/onboarding/swap";
import { spendRange } from "../../src/modules/onboarding/threshold";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * Adding a reward to a tier band and removing a milestone. A milestone is keyed by `n` (issued
 * rewards carry it), so no `n` may change; the ladder must stay in order of spend; and no other
 * row's spend may move.
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

const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error((result as unknown as { reason: string }).reason);

  return result as Extract<T, { ok: true }>;
};

/** A free spend in the band: one euro above an existing row, which no other row sits at. */
const freeSpendIn = (p: Program, band: number): number => {
  const range = bandRange(p, band)!;
  const taken = new Set(p.lad.ms.map((m) => Math.round(p.realTh[m.n])));

  for (let real = range.min; real <= range.max; real += 1) {
    const inserted = insertMilestone(p, band, real);

    if (inserted.ok && !taken.has(real)) return real;
  }

  throw new Error(`no free spend in band ${band}`);
};

/** Adds double points (needs no catalogue) at `real` in `band`, as the service does. */
const added = (p: Program, band: number, real: number): { program: Program; n: number } => {
  const slot = ok(insertMilestone(p, band, real));
  const filled = ok(swapRewardToSpecial(slot.program, ANSWERS, slot.n, { kind: "doble" }));

  return { program: filled.program, n: slot.n };
};

const ascending = (values: number[]): boolean =>
  values.every((v, i) => i === 0 || v > values[i - 1]);

describe("adding a reward to a tier band", () => {
  it("puts it in every band at the spend typed, in order, with a new number", () => {
    const p = fresh();

    for (const band of [1, 2, 3, 4]) {
      const real = freeSpendIn(p, band);
      const { program: next, n } = added(p, band, real);
      const row = presentProgram(next).ladder.find((m) => m.n === n)!;

      expect(row, `band ${band}`).toMatchObject({ band, type: "premio", realSpend: real });
      expect(n).toBe(Math.max(...p.lad.ms.map((m) => m.n)) + 1);
      expect(ascending(next.lad.ms.map((m) => m.th))).toBe(true);
      expect(ascending(next.chosen.map((c) => c.m.th))).toBe(true);
      expect(next.chosen.find((c) => c.m.n === n)!.m.th).toBe(
        next.lad.ms.find((m) => m.n === n)!.th
      );
    }
  });

  it("moves no other row's spend and renumbers nothing", () => {
    const p = fresh();
    const { program: next } = added(p, 2, freeSpendIn(p, 2));

    for (const m of p.lad.ms) {
      expect(next.lad.ms.find((x) => x.n === m.n)!.th).toBe(m.th);
      expect(next.realTh[m.n]).toBeCloseTo(p.realTh[m.n], 9);
    }
  });

  it("is issued at its spend, and can then be moved like any reward", () => {
    const p = fresh();
    const { program: next, n } = added(p, 1, freeSpendIn(p, 1));
    const view = programView(next).milestones.find((m) => m.n === n)!;

    expect(view.issue).toMatchObject({ kind: "VENTAJA", detail: { perk: "doble" } });
    expect(spendRange(next, n)).not.toBeNull();
  });

  it("re-derives the cost with the new reward in it", () => {
    const p = fresh();
    const { program: next } = added(p, 3, freeSpendIn(p, 3));

    expect(next.totalCost).toBeCloseTo(
      next.chosen.reduce((s, c) => s + c.o.cost, 0) + next.perkCost,
      10
    );
    expect(next.totalCost).toBeGreaterThan(p.totalCost);
  });

  it("refuses a band that does not exist, a spend outside it, one already taken, and decimals", () => {
    const p = fresh();
    const range = bandRange(p, 2)!;
    const row = p.lad.ms.find((m) => m.type !== "nivel" && m.tramo === 2)!;

    expect(insertMilestone(p, 5, 100)).toEqual({ ok: false, reason: LADDER_REFUSALS.band });
    expect(insertMilestone(p, 0, 100)).toEqual({ ok: false, reason: LADDER_REFUSALS.band });

    for (const real of [range.min - 1, range.max + 1]) {
      const result = insertMilestone(p, 2, real);

      expect(result.ok ? "" : result.reason).toContain("tiene que estar entre");
    }

    expect(insertMilestone(p, 2, Math.round(p.realTh[row.n]))).toEqual({
      ok: false,
      reason: LADDER_REFUSALS.taken
    });
    expect(insertMilestone(p, 2, 12.5)).toEqual({ ok: false, reason: LADDER_REFUSALS.notWhole });
  });

  it("does not touch the programme it was given", () => {
    const p = fresh();
    const snapshot = JSON.stringify(p);

    added(p, 1, freeSpendIn(p, 1));

    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it("gives each band its range on the admin's screen only, and none to Diamante", () => {
    const p = fresh();
    const tiers = presentProgram(p, { forAdmin: true }).tiers;

    tiers.slice(0, 4).forEach((tier, i) => expect(tier.addRange).toEqual(bandRange(p, i + 1)));
    expect(tiers[4]).not.toHaveProperty("addRange");
    expect(presentProgram(p).tiers.some((t) => "addRange" in t)).toBe(false);
  });
});

describe("removing a milestone", () => {
  it("removes a reward and leaves every other row where it was", () => {
    const p = fresh();
    const n = p.chosen[1].m.n;
    const next = ok(removeMilestone(p, n)).program;

    expect(next.lad.ms.some((m) => m.n === n)).toBe(false);
    expect(next.chosen.some((c) => c.m.n === n)).toBe(false);
    expect(next.realTh).not.toHaveProperty(String(n));

    for (const m of p.lad.ms.filter((x) => x.n !== n)) {
      expect(next.lad.ms.find((x) => x.n === m.n)).toEqual(m);
      expect(next.realTh[m.n]).toBeCloseTo(p.realTh[m.n], 9);
    }

    expect(next.totalCost).toBeCloseTo(p.totalCost - p.chosen[1].o.cost, 9);
  });

  it("removes a perk and its cost", () => {
    const p = fresh();
    const perk = p.lad.ms.find((m) => m.type === "ventaja")!;
    const next = ok(removeMilestone(p, perk.n)).program;

    expect(next.lad.ms.some((m) => m.n === perk.n)).toBe(false);
    expect(next.perkCost).toBeCloseTo(p.perkCost - perk.perk!.cost, 9);
    expect(programView(next).milestones.some((m) => m.n === perk.n)).toBe(false);
  });

  it("refuses a tier step and a milestone that does not exist", () => {
    const p = fresh();
    const level = p.lad.ms.find((m) => m.type === "nivel")!.n;

    for (const n of [level, 999]) {
      expect(removeMilestone(p, n)).toEqual({ ok: false, reason: LADDER_REFUSALS.notRemovable });
    }
  });

  it("never reuses a removed number for a reward added after", () => {
    const p = fresh();
    const top = Math.max(...p.lad.ms.map((m) => m.n));
    const removed = ok(removeMilestone(p, p.chosen[0].m.n)).program;
    const { n } = added(removed, 2, freeSpendIn(removed, 2));

    expect(n).toBe(top + 1);
  });
});
