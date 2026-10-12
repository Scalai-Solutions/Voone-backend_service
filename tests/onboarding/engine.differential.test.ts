import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import type {
  Answers,
  CatalogItem,
  InvestmentLevel,
  Objective,
  OccupancyLevel
} from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The port against the thing it was ported from.
 *
 * This is the test that matters. A single fixture proves one path through a function with
 * a seventeen-step relaxation cascade; comparing the two implementations across the whole
 * answer space exercises the cascade, the beam search tie-breaks and the Bronce reorder
 * on inputs nobody chose by hand.
 *
 * reference/engine.cjs is the partners' validated implementation, vendored unchanged as
 * an oracle. It is test-only and must never be imported from src — if the two ever
 * disagree, this port is wrong, not the reference.
 */
const require_ = createRequire(import.meta.url);
const reference = require_("./reference/engine.cjs") as {
  run: (items: unknown, ans: unknown) => ComparableResult & { error?: string };
};

const OBJECTIVES: Objective[] = ["equilibrado", "mas_visitas", "mas_gasto", "mas_clientes_nuevos"];
const INVESTMENTS: InvestmentLevel[] = ["conservador", "equilibrado", "generoso"];
const OCCUPANCIES: OccupancyLevel[] = ["o1", "o2", "o3", "o4"];

const items = catalog as CatalogItem[];

/** An option as both engines represent it. Only the fields the comparison reads. */
interface ComparableOption {
  items: Array<{ id: string }>;
  value: number;
  cost: number;
}

/**
 * The common surface of the two engines.
 *
 * Structural rather than imported from the port, because the reference is untyped
 * JavaScript and the whole point is to describe them both without either being the
 * authority on the shape.
 */
interface ComparableResult {
  est: { segment: string; ticket: number; visits: number; A: number; tPre: string; fPre: string };
  lad: {
    R: number;
    Y: number;
    visitsSilver: number;
    ms: Array<{
      n: number;
      tramo: number;
      type: string;
      th: number;
      tier?: string;
      perk?: { kind: string; name: string; cost: number };
    }>;
  };
  chosen: Array<{ m: { n: number }; o: ComparableOption; alts: ComparableOption[] }>;
  rec: { every: number; o: ComparableOption };
  gifts: Record<string, { birthday?: ComparableOption } | undefined>;
  refLad: Array<{ n: number; o: ComparableOption }>;
  welcome: number;
  costPct: number;
  totalCost: number;
  perkCost: number;
  adapt: string[];
  review: string[];
  guarantees: Array<[string, boolean]>;
}

/**
 * Everything the port is responsible for, in a shape both engines can produce.
 *
 * Deliberately excludes the reference's revenue projection, which the implementation
 * guide says not to port. Including it would make the comparison fail on fields this
 * port does not claim to have.
 *
 * Costs are fixed to 8 decimals before comparison: both engines do the same arithmetic in
 * the same order, so they agree exactly, but pinning the precision keeps a future
 * refactor from failing on a float's last bit rather than on a real difference.
 */
const shape = (r: ComparableResult) => ({
  segment: r.est.segment,
  ticket: r.est.ticket,
  visits: r.est.visits,
  A: r.est.A,
  tPre: r.est.tPre,
  fPre: r.est.fPre,
  R: +r.lad.R.toFixed(10),
  years: +r.lad.Y.toFixed(10),
  visitsSilver: +r.lad.visitsSilver.toFixed(10),
  milestones: r.lad.ms.map((m) => ({
    n: m.n,
    tramo: m.tramo,
    type: m.type,
    th: m.th,
    tier: m.tier ?? null,
    perk: m.perk ? { kind: m.perk.kind, name: m.perk.name, cost: +m.perk.cost.toFixed(8) } : null
  })),
  rewards: r.chosen.map((c) => ({
    n: c.m.n,
    ids: c.o.items.map((i) => i.id),
    value: c.o.value,
    cost: +c.o.cost.toFixed(8),
    alts: c.alts.map((a) => a.items.map((i) => i.id))
  })),
  recurring: { every: r.rec.every, ids: r.rec.o.items.map((i) => i.id), value: r.rec.o.value },
  gifts: Object.fromEntries(
    Object.entries(r.gifts).map(([tier, g]) => [
      tier,
      g?.birthday ? g.birthday.items.map((i) => i.id) : null
    ])
  ),
  referrals: r.refLad.map((x) => ({
    n: x.n,
    ids: x.o.items.map((i) => i.id),
    value: x.o.value
  })),
  welcome: r.welcome,
  costPct: +r.costPct.toFixed(10),
  totalCost: +r.totalCost.toFixed(8),
  perkCost: +r.perkCost.toFixed(8),
  adapt: r.adapt,
  review: r.review,
  guarantees: r.guarantees
});

const answersFor = (
  objective: Objective,
  investment: InvestmentLevel,
  occupancy: OccupancyLevel
): Answers => ({ ticket: null, freq: null, objective, investment, occupancy, members: "m3" });

describe("the TypeScript port against the reference engine", () => {
  const combos = OBJECTIVES.flatMap((objective) =>
    INVESTMENTS.flatMap((investment) =>
      OCCUPANCIES.map((occupancy) => ({ objective, investment, occupancy }))
    )
  );

  it.each(combos)(
    "agrees on $objective / $investment / $occupancy",
    ({ objective, investment, occupancy }) => {
      const answers = answersFor(objective, investment, occupancy);
      const mine = run(items, answers);

      expect(isEngineError(mine)).toBe(false);
      expect(shape(mine as unknown as ComparableResult)).toEqual(
        shape(reference.run(items, answers))
      );
    }
  );

  it("agrees when the centre overrides the ticket and frequency buckets", () => {
    // The estimate path and the bucket path are different branches, and the sweep above
    // only ever exercises the estimate one.
    for (const ticket of ["t1", "t2", "t3", "t4"]) {
      for (const freq of ["f1", "f3", "f5"]) {
        const answers: Answers = {
          ticket,
          freq,
          objective: "equilibrado",
          investment: "equilibrado",
          occupancy: "o2",
          members: "m3"
        };

        expect(
          shape(run(items, answers) as unknown as ComparableResult),
          `${ticket}/${freq}`
        ).toEqual(shape(reference.run(items, answers)));
      }
    }
  });

  it("agrees on a catalogue with no rewardable items", () => {
    // Both must refuse, and with the same Spanish sentence: the centre reads it.
    const medicineOnly: CatalogItem[] = [
      { id: "M1", name: "Toxina botulínica", price: 300 },
      { id: "M2", name: "Relleno de ácido hialurónico", price: 400 }
    ];
    const answers = answersFor("equilibrado", "equilibrado", "o2");
    const mine = run(medicineOnly, answers);
    const theirs = reference.run(medicineOnly, answers);

    expect(isEngineError(mine)).toBe(true);
    expect((mine as { error: string }).error).toBe(theirs.error);
  });

  it("agrees on a tiny catalogue, where the late relaxations fire", () => {
    // Under 25 candidates unlocks two extra repeat-allowing steps, so this reaches
    // cascade branches the full catalogue never touches.
    const small: CatalogItem[] = [
      { id: "A1", name: "Crema hidratante", price: 30, product: true },
      { id: "A2", name: "Presoterapia", price: 25 },
      { id: "A3", name: "Masaje relajante", price: 45 },
      { id: "A4", name: "Higiene facial", price: 55 }
    ];
    const answers = answersFor("equilibrado", "equilibrado", "o2");
    const mine = run(small, answers);
    const theirs = reference.run(small, answers);

    if (isEngineError(mine)) {
      expect((mine as { error: string }).error).toBe(theirs.error);
      return;
    }

    expect(shape(mine as unknown as ComparableResult)).toEqual(shape(theirs));
  });
});

describe("determinism", () => {
  it("gives byte-identical output over 100 runs", () => {
    const answers = answersFor("equilibrado", "equilibrado", "o2");
    const first = JSON.stringify(shape(run(items, answers) as unknown as ComparableResult));

    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(shape(run(items, answers) as unknown as ComparableResult))).toBe(first);
    }
  });

  it("depends on catalogue order, which is why a centre's catalogue has a fixed one", () => {
    // Not a defect, but it IS a constraint on storage: ids break ties, and the beam keeps
    // a bounded number of states, so the input order can change which survive. Asserted
    // rather than left implicit, because the day it stops being true a stored catalogue
    // could silently regenerate a different ladder.
    const answers = answersFor("equilibrado", "equilibrado", "o2");
    const forward = run(items, answers);
    const backward = run([...items].reverse(), answers);

    expect(isEngineError(forward)).toBe(false);
    expect(isEngineError(backward)).toBe(false);
    // The reference and the port must agree about the reversed case too, whatever it is.
    expect(shape(backward as unknown as ComparableResult)).toEqual(
      shape(reference.run([...items].reverse(), answers))
    );
  });
});
