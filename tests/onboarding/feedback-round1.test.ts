import { describe, expect, it } from "vitest";

import {
  calcDefaults,
  simulate5y,
  validateCalcInput
} from "../../src/modules/onboarding/calculator";
import { run } from "../../src/modules/onboarding/engine";
import { FREQ_BUCKETS, TICKET_BUCKETS } from "../../src/modules/onboarding/engine.config";
import { r1 } from "../../src/modules/onboarding/engine.math";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { answersSchema } from "../../src/modules/onboarding/onboarding.schema";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The founders' first round of feedback on the centre-facing page.
 *
 * Sapphira is the fixture the feedback's own tables are written against, so every number
 * asserted here is one a person at the partner can check against their document: Diamante at
 * 1,500 € of real spend, 650 € of minimum revenue at the tenth referral with a 65 € ticket, and
 * the five-year table for 300 clients at 65 €.
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

const build = (answers: Answers): Program => {
  const result = run(items, answers);

  expect(isEngineError(result)).toBe(false);

  return result as Program;
};

const sapphira = build(BASE);

/** Every key name in a value, however deep, so a leaked field cannot hide in a nested object. */
const keysOf = (value: unknown): string[] =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
    : [];

describe("the centre's own ticket and visits", () => {
  it("is the same programme as before when neither is given", () => {
    const withNulls = build({ ...BASE, ticketValue: null, visitsValue: null });

    expect(JSON.stringify(withNulls)).toBe(JSON.stringify(sapphira));
  });

  it("builds the programme from the exact figures, not the estimate", () => {
    const typed = build({ ...BASE, ticketValue: 80, visitsValue: 4 });

    expect(typed.est.ticket).toBe(80);
    expect(typed.est.visits).toBe(4);
    expect(typed.est.A).toBe(320);
    expect(typed.lad.ms.map((m) => m.th)).not.toEqual(sapphira.lad.ms.map((m) => m.th));
  });

  it("gives the same programme for a bucket's value as for the bucket", () => {
    // The numeric field is the source of truth; the chips are only quick picks. A chip and the
    // number it stands for must therefore be indistinguishable to the engine.
    // A bucket other than the pre-selected one: choosing the pre-selected bucket keeps the exact
    // estimate on purpose, so it would not stand for its own round value.
    const t3 = TICKET_BUCKETS.mid.find((b) => b.id === "t3")!;
    const f3 = FREQ_BUCKETS.find((b) => b.id === "f3")!;

    const byBucket = build({ ...BASE, ticket: "t3", freq: "f3" });
    const byNumber = build({
      ...BASE,
      ticketValue: t3.value,
      visitsValue: r1(52 / f3.weeks)
    });

    expect(JSON.stringify(byNumber.lad)).toBe(JSON.stringify(byBucket.lad));
    expect(byNumber.est.A).toBe(byBucket.est.A);
  });

  it("lets a typed figure win over a bucket that disagrees with it", () => {
    const typed = build({ ...BASE, ticket: "t4", ticketValue: 65 });

    expect(typed.est.ticket).toBe(65);
  });

  it("regenerates thresholds, rewards and referral rewards when annual spend changes", () => {
    const bigger = build({ ...BASE, ticketValue: 120, visitsValue: 5.1 });

    expect(bigger.lad.ms.at(-1)!.th).toBeGreaterThan(sapphira.lad.ms.at(-1)!.th);
    expect(bigger.refLad.map((r) => r.name)).not.toEqual(sapphira.refLad.map((r) => r.name));
  });

  it("keeps the review note when annual spend is more than three times the catalogue's", () => {
    const wild = build({ ...BASE, ticketValue: 300, visitsValue: 5.1 });

    expect(wild.review.join(" ")).toContain("Con tus respuestas");
  });
});

describe("the answers schema", () => {
  const parse = (extra: Record<string, unknown>) =>
    answersSchema.safeParse({
      objective: "equilibrado",
      investment: "equilibrado",
      occupancy: "o2",
      ...extra
    });

  it("accepts figures inside the founders' ranges, and null for 'recommended'", () => {
    expect(parse({ ticketValue: 10, visitsValue: 0.5 }).success).toBe(true);
    expect(parse({ ticketValue: 1000, visitsValue: 26 }).success).toBe(true);
    expect(parse({ ticketValue: null, visitsValue: null }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });

  it.each([
    [{ ticketValue: 9 }, "entre 10 y 1.000"],
    [{ ticketValue: 1001 }, "entre 10 y 1.000"],
    [{ ticketValue: 65.5 }, "número entero"],
    [{ visitsValue: 0.4 }, "entre 0,5 y 26"],
    [{ visitsValue: 27 }, "entre 0,5 y 26"],
    [{ ticketValue: "65" }, "tiene que ser un número"]
  ])("refuses %j in Spanish", (extra, text) => {
    const r = parse(extra);

    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(text);
  });

  it("keeps visits to one decimal", () => {
    const r = parse({ visitsValue: 5.14 });

    expect(r.success && r.data.visitsValue).toBe(5.1);
  });
});

describe("what a centre sees of a programme", () => {
  const shown = presentProgram(sapphira);

  it("never shows what a gift is worth or costs, anywhere", () => {
    const keys = keysOf(shown);

    for (const forbidden of ["value", "cost", "budget", "price", "valor", "coste"]) {
      expect(keys, `a "${forbidden}" key reached the centre's view`).not.toContain(forbidden);
    }

    // And not as text either: the old alternatives read "Item name (45 €)".
    expect(JSON.stringify(shown)).not.toMatch(/\(\d+\s*€\)/);
    expect(JSON.stringify(shown)).not.toMatch(/valor \d/i);
  });

  it("still carries the gifts by name, with their alternatives", () => {
    const rewards = shown.ladder.flatMap((m) => (m.reward ? [m.reward] : []));

    expect(rewards.length).toBeGreaterThan(0);
    expect(rewards.every((r) => r.name)).toBe(true);
    expect(rewards.every((r) => r.items.every((i) => Object.keys(i).join() === "name"))).toBe(true);
    // Not every reward has an alternative, but some do, and those are names only too.
    const withAlternatives = rewards.filter((r) => r.alternatives.length > 0);

    expect(withAlternatives.length).toBeGreaterThan(0);
    expect(withAlternatives[0].alternatives.every((a) => a.name && !("value" in a))).toBe(true);
    expect(shown.recurring.name).toBeTruthy();
    expect(shown.referrals.every((r) => r.name)).toBe(true);
  });

  it("shows the real spend at each milestone, not the progress threshold", () => {
    const real = (n: number) => shown.ladder.find((m) => m.n === n)!.realSpend;

    // The feedback's table: they are equal up to Oro and diverge after it, because progress
    // counts ×1.1 in Oro, ×1.2 in Platino and ×1.3 in Diamante.
    expect(real(1)).toBe(30);
    expect(real(6)).toBe(190); // enters Plata
    expect(real(11)).toBe(490); // enters Oro
    expect(real(16)).toBe(908); // enters Platino
    expect(real(23)).toBe(1500); // enters Diamante

    const diamante = shown.ladder.at(-1)!;

    expect(diamante.threshold).toBeGreaterThan(diamante.realSpend);
  });

  it("gives the month a typical client gets there, at the programme's annual spend", () => {
    const month = (n: number) => shown.ladder.find((m) => m.n === n)!.month;

    expect(month(1)).toBe(1);
    expect(month(6)).toBe(7);
    expect(month(11)).toBe(18);
    expect(month(16)).toBe(33);
    expect(month(23)).toBe(54);
  });

  it("states each tier by the real spend needed to enter it", () => {
    expect(shown.tiers.map((t) => t.threshold)).toEqual([0, 190, 490, 908, 1500]);
  });

  it("shows minimum revenue as referrals × ticket, and follows the ticket", () => {
    expect(shown.referrals.map((r) => [r.n, r.minRevenue])).toEqual([
      [1, 65],
      [3, 195],
      [5, 325],
      [7, 455],
      [10, 650]
    ]);

    const edited = presentProgram(build({ ...BASE, ticketValue: 80, visitsValue: 5.1 }));

    expect(edited.referrals.find((r) => r.n === 10)?.minRevenue).toBe(800);
  });

  it("marks Family & Friends as coming soon", () => {
    expect(shown.familyAndFriends.comingSoon).toBe(true);
  });

  it("states the recurring reward in euros actually paid", () => {
    // Every 250 of progress, at ×1.3 in Diamante, is a reward every ~192 € paid.
    expect(shown.recurring.every).toBe(Math.round(sapphira.rec.every / 1.3));
  });

  it("is identical whether built from the engine's output or the stored copy of it", () => {
    // The stored copy loses a digit of float precision; a centre must not see a difference.
    const stored = JSON.parse(JSON.stringify(sapphira)) as Program;

    expect(presentProgram(stored)).toEqual(shown);
  });
});

describe("the five-year calculator", () => {
  /** The feedback's expected output for 300 clients at 65 €, 5.1 visits. */
  const EXPECTED = [
    { avg: 163, tiers: [230, 70, 0, 0, 0], generates: 10851, costs: 5299, net: 5552 },
    { avg: 300, tiers: [146, 91, 63, 0, 0], generates: 19479, costs: 6099, net: 13380 },
    { avg: 300, tiers: [108, 72, 95, 25, 0], generates: 18866, costs: 6616, net: 12250 },
    { avg: 300, tiers: [99, 72, 48, 81, 0], generates: 18737, costs: 7138, net: 11599 },
    { avg: 300, tiers: [97, 68, 46, 67, 22], generates: 18992, costs: 7612, net: 11380 }
  ];

  const result = simulate5y(sapphira, { clients: 300, ticket: 65 });

  it("defaults to half the clients answer and the programme's own ticket", () => {
    expect(calcDefaults(sapphira, "m3")).toEqual({ clients: 300, ticket: 65 });
    expect(calcDefaults(sapphira, "m1")).toEqual({ clients: 50, ticket: 65 });
  });

  it.each(EXPECTED.map((e, i) => [i + 1, e] as const))(
    "matches the feedback's table for year %i, within 1 €",
    (year, expected) => {
      const y = result.years[year - 1];

      expect(Math.round(y.avgMembers)).toBe(expected.avg);
      expect(
        [y.byTier.bronce, y.byTier.plata, y.byTier.oro, y.byTier.platino, y.byTier.diamante].map(
          Math.round
        )
      ).toEqual(expected.tiers);
      expect(Math.abs(y.generates.total - expected.generates)).toBeLessThanOrEqual(1);
      expect(Math.abs(y.costs.total - expected.costs)).toBeLessThanOrEqual(1);
      expect(Math.abs(y.net - expected.net)).toBeLessThanOrEqual(1);
    }
  );

  it("adds up: net is what it generates less what it costs, and the running total follows", () => {
    let running = 0;

    for (const y of result.years) {
      const gen = y.generates.lines.reduce((s, l) => s + l.amount, 0);
      const cost = y.costs.lines.reduce((s, l) => s + l.amount, 0);

      running += gen - cost;

      expect(y.generates.total).toBeCloseTo(gen, 6);
      expect(y.costs.total).toBeCloseTo(cost, 6);
      expect(y.cumulativeNet).toBeCloseTo(running, 6);
    }
  });

  it("holds every client in exactly one tier at the end of each year", () => {
    for (const y of result.years) {
      const total = Object.values(y.byTier).reduce((s, n) => s + n, 0);

      expect(Math.round(total)).toBe(300);
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(simulate5y(sapphira, { clients: 300, ticket: 65 }))).toBe(
      JSON.stringify(result)
    );
  });

  it("moves clients up faster when they spend more, and never changes the programme", () => {
    const before = JSON.stringify(sapphira);
    const richer = simulate5y(sapphira, { clients: 300, ticket: 120 });

    expect(JSON.stringify(sapphira)).toBe(before);
    // More spend: more clients in the upper tiers by year 3.
    expect(richer.years[2].byTier.diamante + richer.years[2].byTier.platino).toBeGreaterThan(
      result.years[2].byTier.diamante + result.years[2].byTier.platino
    );
  });

  it("scales with the number of clients", () => {
    const small = simulate5y(sapphira, { clients: 150, ticket: 65 });

    expect(small.years[4].generates.total).toBeLessThan(result.years[4].generates.total);
    expect(Math.round(small.years[4].avgMembers)).toBe(150);
  });

  it("reports only yearly totals, never the cost or worth of an individual gift", () => {
    const keys = new Set(keysOf(result));

    for (const forbidden of ["value", "cost", "items", "alternatives", "reward", "name"]) {
      expect(keys.has(forbidden), `"${forbidden}" reached the calculator's output`).toBe(false);
    }
  });

  it("refuses figures outside the ranges, in Spanish", () => {
    expect(validateCalcInput({ clients: 300, ticket: 65 })).toBeNull();
    expect(validateCalcInput({ clients: 9, ticket: 65 })).toContain("entre 10 y 5000");
    expect(validateCalcInput({ clients: 5001, ticket: 65 })).toContain("entre 10 y 5000");
    expect(validateCalcInput({ clients: 300, ticket: 9 })).toContain("entre 10 y 1000");
    expect(validateCalcInput({ clients: 300, ticket: Number.NaN })).toContain("ticket");
  });
});
