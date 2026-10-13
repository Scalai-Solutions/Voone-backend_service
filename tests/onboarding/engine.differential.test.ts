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

const REPEAT = "Ningún regalo se repite en dos hitos seguidos";
/** The sentence the port adds when best-first cannot be had without a repeat. */
const KEPT_NOTE = "En Bronce el mejor premio no va el primero";
const BRONCE_FIRST = "En Bronce el mejor premio es el primero";

const holds = (r: ComparableResult, title: string): boolean =>
  r.guarantees.find(([text]) => text === title)?.[1] ?? true;

/**
 * Compares two orderings of the same first segment as equal, and ignores the two
 * guarantees that the one deliberate deviation can change.
 */
const withoutBronceOrder = (s: ReturnType<typeof shape>) => ({
  ...s,
  rewards: [
    ...s.rewards
      .slice(0, 3)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ n, ...rest }) => rest)
      .sort((a, b) => (a.ids.join() < b.ids.join() ? -1 : 1)),
    ...s.rewards.slice(3)
  ],
  adapt: s.adapt.filter((note) => !note.startsWith(KEPT_NOTE)),
  guarantees: s.guarantees.filter(([text]) => text !== REPEAT && text !== BRONCE_FIRST)
});

/**
 * The port must equal the reference — except in one documented case.
 *
 * Version 1.2 reorders Bronce so its best reward leads, and in doing so can break the
 * guarantee that no gift repeats in two milestones in a row. The port repairs that, so
 * wherever the REFERENCE breaks the guarantee the port is required to hold it, and to
 * differ from the reference in nothing except the order of the three Bronce rewards.
 * Everywhere else the two must be identical. Nothing wider than that is tolerated: a
 * deviation that were allowed to grow would stop proving anything.
 */
const expectAgreement = (
  mine: ComparableResult,
  theirs: ComparableResult,
  label?: string
): void => {
  if (holds(theirs, REPEAT)) {
    expect(shape(mine), label).toEqual(shape(theirs));

    return;
  }

  expect(holds(mine, REPEAT), `${label}: the port must repair the repeat`).toBe(true);

  // When the repair cannot also keep the best reward first, the port says so — and the
  // two facts always come together. A false guarantee without its sentence would be a
  // silent defect; the sentence without a false guarantee would be a lie.
  const saysKept = mine.adapt.some((note) => note.startsWith(KEPT_NOTE));
  expect(holds(mine, BRONCE_FIRST), `${label}: the Bronce guarantee and its note disagree`).toBe(
    !saysKept
  );

  expect(withoutBronceOrder(shape(mine)), label).toEqual(withoutBronceOrder(shape(theirs)));
};

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
      expectAgreement(
        mine as unknown as ComparableResult,
        reference.run(items, answers),
        `${objective}/${investment}/${occupancy}`
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

        expectAgreement(
          run(items, answers) as unknown as ComparableResult,
          reference.run(items, answers),
          `${ticket}/${freq}`
        );
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

    expectAgreement(mine as unknown as ComparableResult, theirs, "tiny catalogue");
  });
});

describe("the one place the port deliberately differs from the reference", () => {
  const FAILING: Array<[Objective, InvestmentLevel, OccupancyLevel]> = [
    ["equilibrado", "conservador", "o4"],
    ["mas_visitas", "conservador", "o4"],
    ["mas_gasto", "conservador", "o3"],
    ["mas_gasto", "conservador", "o4"],
    ["mas_clientes_nuevos", "conservador", "o4"]
  ];

  it.each(FAILING)("repairs the repeat on %s / %s / %s", (objective, investment, occupancy) => {
    const answers = answersFor(objective, investment, occupancy);
    const theirs = reference.run(items, answers);
    const mine = run(items, answers) as unknown as ComparableResult;

    // Pinned to the reference's own failure, so if the reference is ever fixed upstream
    // this test says so instead of quietly passing against nothing.
    expect(holds(theirs, REPEAT), "the reference no longer has this defect").toBe(false);
    expect(holds(mine, REPEAT)).toBe(true);
    expect(holds(mine, BRONCE_FIRST)).toBe(true);
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
    expectAgreement(
      backward as unknown as ComparableResult,
      reference.run([...items].reverse(), answers),
      "reversed catalogue"
    );
  });
});
