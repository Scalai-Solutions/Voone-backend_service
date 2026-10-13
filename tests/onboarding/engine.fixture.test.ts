import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import { CATEGORIES } from "../../src/modules/onboarding/engine.config";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The numbers the implementation guide publishes for the Sapphira centre.
 *
 * Asserted literally rather than derived, because this is the contract: the guide tells
 * the team "your port is correct when it reproduces these", and a test that recomputed
 * them from the engine would agree with any engine at all.
 *
 * The differential test proves this port matches the reference implementation. This one
 * proves the reference still matches what the partners signed off.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const items = catalog as CatalogItem[];

const programFor = (answers: Answers = ANSWERS): Program => {
  const result = run(items, answers);

  if (isEngineError(result)) throw new Error(`engine refused the fixture: ${result.error}`);

  return result;
};

describe("the Sapphira fixture, against the guide's published numbers", () => {
  const p = programFor();

  it("estimates the segment, ticket, visits and annual spend", () => {
    expect(p.est.segment).toBe("high");
    expect(p.est.ticket).toBe(65);
    expect(p.est.visits).toBe(5.1);
    expect(p.est.A).toBe(331.5);
  });

  it("solves the growth factor to 1.534", () => {
    expect(+p.lad.R.toFixed(3)).toBe(1.534);
  });

  it("puts the tier thresholds at 190, 490, 950 and 1660 progress euros", () => {
    const tiers = p.lad.ms.filter((m) => m.type === "nivel").map((m) => m.th);

    expect(tiers).toEqual([190, 490, 950, 1660]);
  });

  it("lays out 5, 4, 4 and 6 milestones across the four segments", () => {
    expect(p.lad.counts).toEqual([5, 4, 4, 6]);
  });

  it("chooses rewards worth 18, 10, 12, 20, 30, 35, 45, 50, 60, 70, 75 and 80", () => {
    expect(p.chosen.map((c) => c.o.value)).toEqual([
      18, 10, 12, 20, 30, 35, 45, 50, 60, 70, 75, 80
    ]);
  });

  it("opens Bronce with its BEST reward, then ascends", () => {
    // The v1.2 reorder, and the reason the first three are 18, 10, 12 rather than sorted.
    const bronce = p.chosen.filter((c) => c.m.tramo === 1).map((c) => c.o.value);

    expect(bronce).toEqual([18, 10, 12]);
    expect(bronce[0]).toBe(Math.max(...bronce));
  });

  it("places the perks at the published thresholds", () => {
    const perks = p.lad.ms.filter((m) => m.perk).map((m) => `${m.perk!.kind}@${m.th}`);

    expect(perks).toEqual([
      "diag@70",
      "doble@130",
      "doble@310",
      "doble@680",
      "doble@1150",
      "mejora@1260",
      "sorpresa@1460"
    ]);
  });

  it("repeats an 80 euro reward every 250 progress euros after Diamante", () => {
    expect(p.rec.every).toBe(250);
    expect(p.rec.o.value).toBe(80);
  });

  it("sets the referral ladder at 20, 48, 82, 113 and 180", () => {
    expect(p.refLad.map((r) => r.o.value)).toEqual([20, 48, 82, 113, 180]);
  });

  it("grants a referred client 15 euros of welcome progress", () => {
    // The guide's expected-values table says 25. The reference says 15, and so does the
    // guide's own stated formula — "half of the first milestone threshold, rounded to the
    // nearest 5" — because that threshold is 30 here, not 50. The reference is the
    // specification, so 15 is correct and the table is stale.
    //
    // Nothing caught it before: sapphira.expected.json carries no welcome field at all,
    // so the fixture test the guide prescribes cannot see this number. Raised with Sergio.
    expect(p.lad.ms[0].th).toBe(30);
    expect(p.welcome).toBe(15);
  });

  it("needs one adaptation note and no review notes", () => {
    expect(p.adapt).toHaveLength(1);
    expect(p.review).toEqual([]);
  });

  it("holds every guarantee", () => {
    expect(p.guarantees.filter(([, held]) => !held)).toEqual([]);
  });
});

describe("invariants the guide requires of any programme", () => {
  const p = programFor();

  it("puts the first reward within reach of the first visit", () => {
    expect(p.lad.ms[0].th).toBeLessThanOrEqual(p.est.ticket);
  });

  it("never lets a reward be worth less than the one before it", () => {
    // Outside Bronce, which leads with its best by design.
    const later = p.chosen.filter((c) => c.m.tramo > 1).map((c) => c.o.value);

    expect([...later].sort((a, b) => a - b)).toEqual(later);
  });

  it("gives no item twice in consecutive rewards", () => {
    const sequence = p.chosen.map((c) => c.o.items.map((i) => i.id));

    for (let i = 1; i < sequence.length; i += 1) {
      expect(
        sequence[i].some((id) => sequence[i - 1].includes(id)),
        `at reward ${i + 1}`
      ).toBe(false);
    }
  });

  it("never gives away pharmacological medicine, which is a legal constraint", () => {
    // MFA earns no progress and can never be a reward. Checked across every surface a
    // catalogue item can reach, not just the ladder.
    const given = [
      ...p.chosen.flatMap((c) => c.o.items),
      ...p.refLad.flatMap((r) => r.o.items),
      ...p.rec.o.items,
      ...Object.values(p.gifts).flatMap((g) => g.birthday?.items ?? [])
    ];

    expect(given.filter((i) => CATEGORIES[i.cat].pharma)).toEqual([]);
    expect(given.filter((i) => !CATEGORIES[i.cat].reward)).toEqual([]);
  });

  it("keeps the whole programme within half again of the chosen investment", () => {
    expect(p.costPct).toBeLessThanOrEqual(p.lad.inv * 1.5);
  });

  it("reaches Diamante in a believable number of years", () => {
    const years = p.diamondReal / p.est.A;

    expect(years).toBeGreaterThanOrEqual(2.5);
    expect(years).toBeLessThanOrEqual(8);
  });

  it("gives every segment a double-points perk", () => {
    for (const tramo of [1, 2, 3, 4]) {
      expect(
        p.lad.ms.some((m) => m.tramo === tramo && m.perk?.kind === "doble"),
        `segment ${tramo}`
      ).toBe(true);
    }
  });

  it("keeps the free diagnosis in Bronce and nowhere else", () => {
    const diag = p.lad.ms.filter((m) => m.perk?.kind === "diag");

    expect(diag).toHaveLength(1);
    expect(diag[0].tramo).toBe(1);
  });

  it("offers only alternatives that preserve the ladder's ordering", () => {
    // What makes a swap safe for the centre to make unsupervised.
    p.chosen.forEach((c, i) => {
      const lo = i ? p.chosen[i - 1].o.value : 0;
      const hi = i < p.chosen.length - 1 ? p.chosen[i + 1].o.value : Infinity;

      for (const alt of c.alts) {
        expect(alt.value, `alternative at reward ${i + 1}`).toBeGreaterThan(lo);
        expect(alt.value, `alternative at reward ${i + 1}`).toBeLessThan(hi);
      }
    });
  });
});

describe("edge catalogues", () => {
  const answers = ANSWERS;

  it("refuses an empty catalogue with a sentence the centre can act on", () => {
    const result = run([], answers);

    expect(isEngineError(result)).toBe(true);
    expect((result as { error: string }).error).toContain("tratamientos con precio");
  });

  it("refuses a catalogue of nothing but medicine", () => {
    const result = run(
      [
        { id: "M1", name: "Toxina botulínica", price: 300 },
        { id: "M2", name: "Relleno de ácido hialurónico", price: 400 }
      ],
      answers
    );

    expect(isEngineError(result)).toBe(true);
  });

  it("throws no exception on a retail-only catalogue, whatever it decides", () => {
    // Retail carries no demand weight, so it cannot produce a ticket estimate. The
    // requirement is a clear Spanish answer either way, never a crash.
    const retail: CatalogItem[] = Array.from({ length: 6 }, (_, i) => ({
      id: `C${i}`,
      name: `Crema ${i}`,
      price: 20 + i * 5,
      product: true
    }));

    const result = run(retail, answers);

    if (isEngineError(result)) {
      expect(result.error.length).toBeGreaterThan(0);
    } else {
      expect(result.chosen.length).toBeGreaterThan(0);
    }
  });

  it("flags unclassified rows for review rather than guessing", () => {
    const result = run(
      [...items, { id: "X1", name: "Servicio sin nombre reconocible", price: 40 }],
      answers
    );

    expect(isEngineError(result)).toBe(false);
    const p = result as Program;

    expect(p.catalog.find((i) => i.id === "X1")?.review).toBe(true);
    expect(p.review.some((r) => r.includes("sin categoría"))).toBe(true);
  });
});
