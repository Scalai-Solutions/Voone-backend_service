import { describe, expect, it, vi } from "vitest";

import { logger } from "../../src/common/logger/logger";

import { compareFiveYears } from "../../src/modules/onboarding/comparison";
import { classify, manualCandidates, run } from "../../src/modules/onboarding/engine";
import type {
  Answers,
  CatalogItem,
  ClassifiedItem,
  Program
} from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { swapRewardToItem } from "../../src/modules/onboarding/swap";
import {
  whatIf,
  type WhatIf,
  type WhatIfRequest,
  type WhatIfRow
} from "../../src/modules/change-requests/change-flag";
import catalog from "../onboarding/reference/sapphira.catalogo.json";

/**
 * The what-if engine on a real Sapphira programme: every number here comes from the real engine,
 * calculator and swap, never from a mock. Milestone 14 holds F3 (Tratamiento Mirada, 50 euros, cost
 * 10), milestone 22 (the last premio) holds C4 and is also the recurring reward.
 */
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const generate = (): Program => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

/** A row as the database stores it: the engine's own output is kept as the baseline. */
const row = (withRecommended = true): WhatIfRow => {
  const program = generate();

  return {
    output: withRecommended ? { ...program, recommended: structuredClone(program) } : program,
    answers: ANSWERS,
    catalogSnapshot: catalog
  };
};

const liveCatalogue = (): ClassifiedItem[] => classify(structuredClone(catalog) as CatalogItem[]);

const okOf = (result: WhatIf) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);

  return result;
};

const reward = (milestone: number, itemId: string): WhatIfRequest => ({
  type: "REWARD",
  milestone,
  itemId
});

const proposedSeries = (result: WhatIf): number[] =>
  okOf(result).years.map((y) => y.proposedCumulative);

describe("whatIf REWARD with an item", () => {
  it("a dearer giftable item costs more over five years, a cheaper one costs less", () => {
    const dearer = okOf(whatIf(row(), liveCatalogue(), reward(14, "L2")));
    const cheaper = okOf(whatIf(row(), liveCatalogue(), reward(14, "W8")));

    expect(dearer.years).toHaveLength(5);
    expect(dearer.years.map((y) => y.year)).toEqual([1, 2, 3, 4, 5]);
    expect(dearer.years[4].proposedCumulative).toBeLessThan(dearer.years[4].liveCumulative);
    expect(cheaper.years[4].proposedCumulative).toBeGreaterThan(cheaper.years[4].liveCumulative);
  });

  it("takes live and recommended from the comparison of the row, and the inputs from its calculator", () => {
    const stored = row();
    const comparison = compareFiveYears(stored);
    const result = okOf(whatIf(stored, liveCatalogue(), reward(14, "L2")));

    expect(result.years.map((y) => y.liveCumulative)).toEqual(
      comparison.years.map((y) => y.currentCumulative)
    );
    expect(result.years.map((y) => y.recommendedCumulative)).toEqual(
      comparison.years.map((y) => y.recommendedCumulative)
    );
    expect(result.inputs).toEqual(comparison.inputs);
    expect(result.reason).toBeNull();
  });

  it("proposes exactly what the swap on the programme plus the comparison produces", () => {
    const stored = row();
    const swapped = swapRewardToItem(stored.output as Program, ANSWERS, 14, "L2");

    if (!swapped.ok) throw new Error(swapped.reason);

    const expected = compareFiveYears({ ...stored, output: swapped.program }).years.map(
      (y) => y.currentCumulative
    );

    expect(proposedSeries(whatIf(stored, liveCatalogue(), reward(14, "L2")))).toEqual(expected);
  });
});

describe("whatIf REWARD refuses what cannot be a reward", () => {
  it("returns none for a medical item, an unknown id and an id that is not in the catalogue", () => {
    for (const itemId of ["M1", "NOT-A-ROW", "retail-only-sku"]) {
      const result = whatIf(row(), liveCatalogue(), reward(14, itemId));

      expect(result.status).toBe("none");
    }
  });

  it("returns none for an item the clinic no longer has, even if the old snapshot did", () => {
    const live = liveCatalogue().filter((item) => item.id !== "K8");

    expect(whatIf(row(), live, reward(14, "K8")).status).toBe("none");
  });

  it("returns none when there is no milestone to put the item in", () => {
    expect(whatIf(row(), liveCatalogue(), { type: "REWARD", itemId: "L2" }).status).toBe("none");
  });
});

describe("whatIf REWARD reads the clinic's catalogue as it is today, not the snapshot", () => {
  it("accepts a giftable item added after the programme was generated", () => {
    const stored = row();
    const added = classify([
      { id: "NEW-1", name: "Peeling suave", price: 40, cat: "FAC" } as CatalogItem
    ])[0];
    const live = [...liveCatalogue(), added];

    expect((stored.output as Program).catalog.some((i) => i.id === "NEW-1")).toBe(false);

    const result = okOf(whatIf(stored, live, reward(14, "NEW-1")));

    expect(result.years[4].proposedCumulative).not.toBe(result.years[4].liveCumulative);
  });

  it("prices an item with its new price when it was repriced after generation", () => {
    const stored = row();
    const snapshotPriced = proposedSeries(whatIf(stored, liveCatalogue(), reward(14, "K8")));
    const live = liveCatalogue().map((item) => (item.id === "K8" ? { ...item, price: 400 } : item));
    const repriced = proposedSeries(whatIf(stored, live, reward(14, "K8")));

    // Same item, dearer today: the plan costs more, so the five-year net is lower.
    expect(repriced[4]).toBeLessThan(snapshotPriced[4]);

    // And the answer is what the swap gives when the programme's own catalogue holds today's row.
    const program = structuredClone(stored.output as Program);

    program.catalog = program.catalog.map((item) =>
      item.id === "K8" ? { ...item, price: 400 } : item
    );

    const swapped = swapRewardToItem(program, ANSWERS, 14, "K8");

    if (!swapped.ok) throw new Error(swapped.reason);

    const expected = compareFiveYears({
      ...stored,
      output: { ...swapped.program, recommended: (stored.output as Program).recommended }
    }).years.map((y) => y.currentCumulative);

    expect(repriced).toEqual(expected);
  });
});

describe("whatIf REWARD when the engine refuses the swap", () => {
  it("returns none with the swap's own reason for a milestone that is not a premio", () => {
    const result = whatIf(row(), liveCatalogue(), reward(2, "L2"));

    expect(result).toEqual({
      status: "none",
      reason: "Ese hito no tiene un premio que se pueda cambiar."
    });
    expect(whatIf(row(), liveCatalogue(), reward(999, "L2")).status).toBe("none");
  });
});

describe("whatIf REWARD with free text", () => {
  it("is unpriced and carries no figures", () => {
    const result = whatIf(row(), liveCatalogue(), {
      type: "REWARD",
      milestone: 14,
      text: "Un masaje"
    });

    expect(result).toEqual({ status: "unpriced" });
    expect("years" in result).toBe(false);
  });

  it("is none when there is neither an item nor a text", () => {
    expect(whatIf(row(), liveCatalogue(), { type: "REWARD", milestone: 14 }).status).toBe("none");
  });

  it("prices the item when both an item and a text are given", () => {
    const result = whatIf(row(), liveCatalogue(), {
      type: "REWARD",
      milestone: 14,
      itemId: "L2",
      text: "Mejor la zona grande"
    });

    expect(result.status).toBe("ok");
  });
});

describe("whatIf on rows the engine cannot fully compare", () => {
  it("without a stored recommendation, replays it and says so in reason", () => {
    const stored = row(false);
    const comparison = compareFiveYears(stored);
    const result = okOf(whatIf(stored, liveCatalogue(), reward(14, "L2")));

    expect(comparison.reason).not.toBeNull();
    expect(result.reason).toBe(comparison.reason);
    expect(result.years.every((y) => typeof y.recommendedCumulative === "number")).toBe(true);
    expect(result.years.map((y) => y.recommendedCumulative)).toEqual(
      comparison.years.map((y) => y.recommendedCumulative)
    );
  });

  it("returns none, and does not throw, when the stored output cannot be simulated", () => {
    const broken: WhatIfRow[] = [
      { output: {}, answers: ANSWERS, catalogSnapshot: catalog },
      { output: null, answers: null, catalogSnapshot: null },
      { output: "garbage", answers: ANSWERS, catalogSnapshot: [] }
    ];

    for (const stored of broken) {
      expect(() => whatIf(stored, liveCatalogue(), reward(14, "L2"))).not.toThrow();
      expect(whatIf(stored, liveCatalogue(), reward(14, "L2")).status).toBe("none");
      expect(
        whatIf(stored, liveCatalogue(), { type: "SERVICE_EDIT", externalId: "F3", priceEuro: 99 })
          .status
      ).toBe("none");
    }
  });
});

describe("whatIf SERVICE_EDIT", () => {
  const swapAfterRepricing = (
    stored: WhatIfRow,
    milestone: number,
    itemId: string,
    price: number
  ) => {
    // Independently: put the new price in the programme's own catalogue, then the real swap.
    const program = structuredClone(stored.output as Program);

    program.catalog = program.catalog.map((item) =>
      item.id === itemId ? { ...item, price } : item
    );

    const swapped = swapRewardToItem(program, ANSWERS, milestone, itemId);

    if (!swapped.ok) throw new Error(swapped.reason);

    return compareFiveYears({ ...stored, output: swapped.program }).years.map(
      (y) => y.currentCumulative
    );
  };

  it("repricing a service used at a milestone equals swapping that milestone to it at the new price", () => {
    const stored = row();
    const edit = whatIf(stored, liveCatalogue(), {
      type: "SERVICE_EDIT",
      externalId: "F3",
      priceEuro: 120
    });
    const expected = swapAfterRepricing(stored, 14, "F3", 120);
    const live = okOf(edit).years.map((y) => y.liveCumulative);

    expect(proposedSeries(edit)).toEqual(expected);
    // It is a real change, not the live plan handed back.
    expect(proposedSeries(edit)).not.toEqual(live);
    expect(proposedSeries(edit)[4]).toBeLessThan(live[4]);
  });

  it("agrees through the REWARD path when the repriced item is in the live catalogue", () => {
    const stored = row();
    const live = liveCatalogue().map((item) => (item.id === "F3" ? { ...item, price: 120 } : item));
    const viaSwap = proposedSeries(whatIf(stored, live, reward(14, "F3")));
    const viaEdit = proposedSeries(
      whatIf(stored, liveCatalogue(), { type: "SERVICE_EDIT", externalId: "F3", priceEuro: 120 })
    );

    expect(viaEdit).toEqual(viaSwap);
  });

  it("holds for the last premio, which is also the recurring reward", () => {
    const stored = row();
    const edit = whatIf(stored, liveCatalogue(), {
      type: "SERVICE_EDIT",
      externalId: "C4",
      priceEuro: 200
    });

    expect(proposedSeries(edit)).toEqual(swapAfterRepricing(stored, 22, "C4", 200));
    expect(proposedSeries(edit)[4]).toBeLessThan(okOf(edit).years[4].liveCumulative);
  });

  it("reprices a recurring reward that no milestone holds", () => {
    const base = generate();
    const [k3] = manualCandidates(
      liveCatalogue().filter((item) => item.id === "K3"),
      ANSWERS
    );

    base.rec = { ...base.rec, o: { items: [k3], value: k3.value, cost: k3.cost } };

    const stored: WhatIfRow = {
      output: { ...base, recommended: structuredClone(base) },
      answers: ANSWERS,
      catalogSnapshot: catalog
    };
    const edit = whatIf(stored, liveCatalogue(), {
      type: "SERVICE_EDIT",
      externalId: "K3",
      priceEuro: 100
    });
    // Independently: the same programme with the recurring reward's cost set by hand.
    const dearer = structuredClone(base);
    const [k3Dear] = manualCandidates(
      [{ ...liveCatalogue().find((item) => item.id === "K3")!, price: 100 }],
      ANSWERS
    );

    dearer.rec = { ...dearer.rec, o: { items: [k3Dear], value: k3Dear.value, cost: k3Dear.cost } };

    expect(proposedSeries(edit)).toEqual(
      compareFiveYears({ ...stored, output: { ...dearer, recommended: base } }).years.map(
        (y) => y.currentCumulative
      )
    );
    expect(proposedSeries(edit)[4]).toBeLessThan(okOf(edit).years[4].liveCumulative);
  });

  it("reprices one item of a combo reward and keeps the other at its price", () => {
    const base = generate();
    const cands = manualCandidates(
      liveCatalogue().filter((item) => item.id === "F3" || item.id === "K3"),
      ANSWERS
    );
    const at = base.chosen.findIndex((c) => c.m.n === 14);

    base.chosen[at].o = {
      items: cands,
      value: cands.reduce((sum, c) => sum + c.value, 0),
      cost: cands.reduce((sum, c) => sum + c.cost, 0)
    };

    const stored: WhatIfRow = {
      output: { ...base, recommended: structuredClone(base) },
      answers: ANSWERS,
      catalogSnapshot: catalog
    };
    const net5 = (priceEuro: number): number =>
      okOf(whatIf(stored, liveCatalogue(), { type: "SERVICE_EDIT", externalId: "K3", priceEuro }))
        .years[4].proposedCumulative;

    // The dearer the combo's K3, the less the plan nets; each price moves the series.
    expect(net5(200)).toBeLessThan(net5(100));
    expect(net5(100)).toBeLessThan(net5(5));
  });

  it("a cheaper price gives a better five-year net", () => {
    const edit = okOf(
      whatIf(row(), liveCatalogue(), { type: "SERVICE_EDIT", externalId: "F3", priceEuro: 5 })
    );

    expect(edit.years[4].proposedCumulative).toBeGreaterThan(edit.years[4].liveCumulative);
  });

  it("is none for a service that is not a live reward, one that is unknown and a bad price", () => {
    const stored = row();

    expect(
      whatIf(stored, liveCatalogue(), { type: "SERVICE_EDIT", externalId: "K8", priceEuro: 60 })
    ).toEqual({ status: "none", reason: expect.stringContaining("not a live reward") });
    expect(
      whatIf(stored, liveCatalogue(), { type: "SERVICE_EDIT", externalId: "NOPE", priceEuro: 60 })
        .status
    ).toBe("none");

    for (const priceEuro of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        whatIf(stored, liveCatalogue(), { type: "SERVICE_EDIT", externalId: "F3", priceEuro })
          .status
      ).toBe("none");
    }
  });

  it("is none when the live row of a live reward is gone from the catalogue", () => {
    const live = liveCatalogue().filter((item) => item.id !== "F3");

    expect(
      whatIf(row(), live, { type: "SERVICE_EDIT", externalId: "F3", priceEuro: 120 }).status
    ).toBe("none");
  });
});

describe("whatIf never changes what it was given", () => {
  it("leaves the row and the live catalogue exactly as they were", () => {
    const stored = row();
    const live = liveCatalogue();
    const storedBefore = structuredClone(stored);
    const liveBefore = structuredClone(live);
    const requests: WhatIfRequest[] = [
      reward(14, "L2"),
      reward(14, "M1"),
      reward(2, "L2"),
      { type: "REWARD", text: "Un masaje" },
      { type: "SERVICE_EDIT", externalId: "F3", priceEuro: 120 },
      { type: "SERVICE_EDIT", externalId: "C4", priceEuro: 200 }
    ];

    for (const req of requests) whatIf(stored, live, req);

    expect(stored).toEqual(storedBefore);
    expect(live).toEqual(liveBefore);
  });
});

describe("whatIf never throws, and never hides a programming error", () => {
  it("logs the error it swallows and still answers none", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    // A broken catalogue is a programming error, not a business refusal.
    const result = whatIf(row(), null as unknown as ClassifiedItem[], reward(14, "L2"));

    expect(result.status).toBe("none");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("change-flag");
    expect(spy.mock.calls[0][1]).toMatchObject({ error: expect.stringContaining("TypeError") });
  });

  it("does not log a plain refusal", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    expect(whatIf(row(), liveCatalogue(), reward(14, "NOT-A-ROW")).status).toBe("none");
    expect(spy).not.toHaveBeenCalled();
  });
});
