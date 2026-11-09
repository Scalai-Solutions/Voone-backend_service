import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import { FREQ_BUCKETS, P } from "../../src/modules/onboarding/engine.config";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { resolveTier } from "../../src/modules/onboarding/runtime/rules";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The tuned ladder, on the engine's own defaults (the suites that pin the partners' original
 * settings say so at the top, and engine.differential.test.ts proves the algorithm is otherwise
 * unchanged).
 *
 * What the tuning is for: a member used to be rewarded out of the first stretch before it had
 * begun, three rewards and two perks inside three visits. Now Plata sits about five visits in,
 * the first stretch holds two rewards about a visit apart, and each later level costs only a
 * little more than the one before, so Diamante still lands near five years.
 */
const items = catalog as CatalogItem[];
const BASE: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const programFor = (answers: Answers = BASE): Program => {
  const result = run(items, answers);

  if (isEngineError(result)) throw new Error(`engine refused: ${result.error}`);

  return result;
};

const levels = (p: Program): number[] =>
  p.lad.ms.filter((m) => m.type === "nivel").map((m) => m.th);

const premiosIn = (p: Program, tramo: number): number =>
  p.lad.ms.filter((m) => m.tramo === tramo && m.type === "premio").length;

describe("the tuned defaults", () => {
  it("are the ones the reference tuning in reference-tuning.ts departs from", () => {
    expect(P.visitsSilver).toBe(5);
    expect(P.minGrowth).toBe(1.15);
    expect(P.premiosFirstTramo).toBe(2);
    expect(P.premiosPerTramo).toBe(3);
    expect(P.allowBronceRepeat).toBe(true);
  });
});

describe("the Sapphira centre on the tuned ladder", () => {
  const p = programFor();

  it("puts Plata about five visits in and keeps Diamante near five years", () => {
    expect(p.lad.visitsSilver).toBe(5);
    expect(levels(p)).toEqual([320, 700, 1140, 1660]);
    expect(p.lad.Y).toBeCloseTo(5, 5);
  });

  it("makes each level only a little dearer than the last, never less than a floor of 1.15", () => {
    expect(p.lad.R).toBeGreaterThanOrEqual(P.minGrowth);
    expect(p.lad.R).toBeLessThan(1.25);

    const steps = levels(p).map((th, i, all) => th - (all[i - 1] ?? 0));

    // Plata is the big hurdle; after it the steps grow gently rather than doubling.
    expect(steps[0]).toBeGreaterThan(300);
    for (let i = 2; i < steps.length; i += 1) {
      expect(steps[i] / steps[i - 1]).toBeLessThan(1.25);
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    }
  });

  it("holds two rewards before Plata and three in every later stretch", () => {
    expect([1, 2, 3, 4].map((t) => premiosIn(p, t))).toEqual([2, 3, 3, 3]);
  });

  it("gives the first reward on the first visit, not before it is paid for", () => {
    const first = p.lad.ms[0];

    expect(first.type).toBe("premio");
    expect(first.th).toBeLessThanOrEqual(p.est.ticket);
    expect(first.th).toBeGreaterThan(p.est.ticket / 2);
  });

  it("never lets more than the stated visits pass without something happening", () => {
    const ths = p.lad.ms.map((m) => m.th);
    const gaps = ths.map((th, i) => th - (ths[i - 1] ?? 0));
    const limit = P.maxVisitsBetween * p.est.ticket + P.round;

    // The first stretch is the one that was widened, so it is the one to check in euros.
    const firstStretch = p.lad.ms.filter((m) => m.tramo === 1).length;

    for (const gap of gaps.slice(0, firstStretch)) expect(gap).toBeLessThanOrEqual(limit);
  });

  it("spends the same total budget however the stretches are cut", () => {
    const budget = p.lad.tramos.reduce((sum, t) => sum + t.budget, 0);
    const rewards = p.lad.ms.filter((m) => m.type === "premio").reduce((sum, m) => sum + m.cb, 0);

    expect(rewards).toBeCloseTo(budget, 6);
  });

  it("holds the guarantees it states, apart from the cost note where there is one", () => {
    const failed = p.guarantees.filter(([, held]) => !held);

    expect(failed).toEqual([]);
  });

  it("moves a member up at exactly Plata's threshold, by points alone", () => {
    const view = programView(p);
    const at = (progress: number) =>
      resolveTier(view, { progress, tenureMonths: 0, current: null }).tier.key;

    expect(at(310)).toBe("bronce");
    expect(at(320)).toBe("plata");
    expect(at(700)).toBe("oro");
    expect(at(1660)).toBe("diamante");
  });
});

describe("across the answer space", () => {
  const combos = ["t1", "t2", "t3", "t4"].flatMap((ticket) =>
    FREQ_BUCKETS.map((f) => ({ ticket, freq: f.id }))
  );

  it.each(combos)("stays inside its limits for ticket $ticket, frequency $freq", (c) => {
    const p = programFor({ ...BASE, ...c });

    // Plata is never closer than the minimum and never further than the target.
    expect(p.lad.visitsSilver).toBeGreaterThanOrEqual(P.minVisitsSilver - 1e-9);
    expect(p.lad.visitsSilver).toBeLessThanOrEqual(P.visitsSilver + 1e-9);
    // Diamante never beyond the ceiling, and no level cheaper to climb than the floor allows.
    expect(p.lad.Y).toBeLessThanOrEqual(P.maxYears + 1e-9);
    expect(p.lad.R).toBeGreaterThanOrEqual(P.minGrowth - 1e-9);
    // The first reward is always within the first visit's spend, and the structure holds.
    expect(p.lad.ms[0].th).toBeLessThanOrEqual(p.est.ticket);
    expect([1, 2, 3, 4].map((t) => premiosIn(p, t))).toEqual([2, 3, 3, 3]);
    // Thresholds only ever rise.
    const ths = p.lad.ms.map((m) => m.th);

    expect(ths).toEqual([...ths].sort((a, b) => a - b));
  });
});

describe("the best Bronce reward leads, even where a gift then repeats", () => {
  const OBJECTIVES = ["equilibrado", "mas_visitas", "mas_gasto", "mas_clientes_nuevos"] as const;
  const INVESTMENTS = ["conservador", "equilibrado", "generoso"] as const;
  const OCCUPANCIES = ["o1", "o2", "o3", "o4"] as const;
  const combos = OBJECTIVES.flatMap((objective) =>
    INVESTMENTS.flatMap((investment) =>
      OCCUPANCIES.map((occupancy) => ({ objective, investment, occupancy }))
    )
  );

  it("holds in all 48 combinations, and any repeat it allows is said in an adapt note", () => {
    for (const c of combos) {
      const p = programFor({ ...BASE, ...c });
      const bronce = p.chosen.filter((r) => r.m.tramo === 1);
      const repeat = p.guarantees.find(([text]) => text.startsWith("Ningún regalo se repite"));
      const first = p.guarantees.find(([text]) => text.startsWith("En Bronce el mejor premio"));

      expect(first?.[1], `${c.objective}/${c.investment}/${c.occupancy}`).toBe(true);
      expect(bronce.every((r) => r.o.value <= bronce[0].o.value)).toBe(true);

      if (repeat && !repeat[1]) {
        expect(
          p.adapt.some((note) =>
            note.startsWith("En Bronce el mejor premio va el primero, aunque")
          ),
          `${c.objective}/${c.investment}/${c.occupancy}`
        ).toBe(true);
      }
    }
  });
});
