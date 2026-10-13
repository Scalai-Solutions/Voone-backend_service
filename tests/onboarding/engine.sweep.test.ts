import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import type {
  Answers,
  InvestmentLevel,
  Objective,
  OccupancyLevel,
  Program
} from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalog from "./reference/sapphira.catalogo.json";
import type { CatalogItem } from "../../src/modules/onboarding/engine.types";

/**
 * The guide's sweep test, as it can truthfully be written.
 *
 * Section 7 of the guide asks for all 48 objective × investment × occupancy combinations
 * to return "a program with no error and no review notes", every guarantee true. That is
 * not achievable by any implementation, the reference included: five combinations exceed
 * the cost ceiling by a tenth of a point (6.1% against 6%, 9.1% against 9%), and the
 * guide's own rules say that raises a blocking review note. The test and the rules
 * contradict each other, and the rules are the specification.
 *
 * So this asserts what is actually required, in two parts:
 *
 *  1. Nothing throws and nothing is refused, over the whole answer space.
 *  2. Wherever a guarantee is false, a review note says why. A false guarantee with no
 *     explanation would be a silent defect; that is the thing being ruled out.
 *
 * The five cost cases are pinned by name. If a recalibration changes the set, this fails
 * and someone looks at it, rather than the change being absorbed by a loose assertion.
 */
const OBJECTIVES: Objective[] = ["equilibrado", "mas_visitas", "mas_gasto", "mas_clientes_nuevos"];
const INVESTMENTS: InvestmentLevel[] = ["conservador", "equilibrado", "generoso"];
const OCCUPANCIES: OccupancyLevel[] = ["o1", "o2", "o3", "o4"];

const items = catalog as CatalogItem[];
const COST = /^Premios y ventajas cuestan el/;
const COST_NOTE = "supera en más de un 50%";

/** Cost-ceiling overruns on the Sapphira fixture, as of config 2026-10-07.1. */
const OVER_BUDGET = new Set([
  "equilibrado/conservador/o3",
  "mas_clientes_nuevos/conservador/o3",
  "equilibrado/generoso/o4",
  "mas_visitas/generoso/o4",
  "mas_clientes_nuevos/generoso/o4"
]);

const combos = OBJECTIVES.flatMap((objective) =>
  INVESTMENTS.flatMap((investment) =>
    OCCUPANCIES.map((occupancy) => ({ objective, investment, occupancy }))
  )
);

const programFor = (c: (typeof combos)[number]): Program => {
  const answers: Answers = { ticket: null, freq: null, ...c, members: "m3" };
  const result = run(items, answers);

  if (isEngineError(result)) throw new Error(`refused: ${result.error}`);

  return result;
};

const key = (c: (typeof combos)[number]): string => `${c.objective}/${c.investment}/${c.occupancy}`;

describe("the 48-combination sweep", () => {
  it("returns a programme for every combination, and never throws", () => {
    for (const c of combos) expect(() => programFor(c), key(c)).not.toThrow();
  });

  it.each(combos)("explains every false guarantee: $objective / $investment / $occupancy", (c) => {
    const p = programFor(c);
    const failed = p.guarantees.filter(([, held]) => !held).map(([text]) => text);

    // Only the cost guarantee can be false on this catalogue; the repeat and Bronce ones
    // were repaired, and nothing else is ever false.
    for (const text of failed) expect(text, key(c)).toMatch(COST);

    // ...and it is never false in silence.
    if (failed.length) {
      expect(
        p.review.some((note) => note.includes(COST_NOTE)),
        `${key(c)} has a false guarantee with no review note`
      ).toBe(true);
    }
  });

  it("raises a cost review note exactly when the cost guarantee is false", () => {
    // The two are the same condition written twice in the engine. If they ever diverge,
    // either a centre is blocked for nothing or a defective programme is let through.
    for (const c of combos) {
      const p = programFor(c);
      const costFalse = p.guarantees.some(([text, held]) => COST.test(text) && !held);
      const noted = p.review.some((note) => note.includes(COST_NOTE));

      expect(noted, key(c)).toBe(costFalse);
    }
  });

  it("holds the repeat and Bronce guarantees in all 48", () => {
    // What the Bronce repair is for. Before it, five combinations broke the first.
    for (const c of combos) {
      const p = programFor(c);

      for (const [text, held] of p.guarantees) {
        if (!COST.test(text)) expect(held, `${key(c)}: ${text}`).toBe(true);
      }
    }
  });

  it("goes over budget in exactly the five known combinations", () => {
    const over = new Set(
      combos.filter((c) => programFor(c).review.some((note) => note.includes(COST_NOTE))).map(key)
    );

    expect(over).toEqual(OVER_BUDGET);
  });

  it("only ever goes over budget at the extremes of investment and agenda", () => {
    // Not a rule, an observation worth keeping honest: every overrun is a conservador or
    // generoso level on a busy agenda, where the chair-time multiplier inflates gift cost
    // past what the chosen share of spend can carry. Equilibrado never overruns.
    for (const c of combos.filter((x) => OVER_BUDGET.has(key(x)))) {
      expect(c.investment).not.toBe("equilibrado");
      expect(["o3", "o4"]).toContain(c.occupancy);
    }
  });
});
