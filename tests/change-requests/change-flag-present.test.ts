import { describe, expect, it } from "vitest";

import {
  presentAdminFlag,
  presentOwnerFlag,
  type WhatIfYear
} from "../../src/modules/change-requests/change-flag-present";

/** Five years where only year 1 differs from the live plan; the rest are flat. */
const years = (live: number, proposed: number, recommended: number | null = null): WhatIfYear[] =>
  [1, 2, 3, 4, 5].map((year) => ({
    year,
    liveCumulative: live,
    proposedCumulative: proposed,
    recommendedCumulative: recommended
  }));

const firstCell = (live: number, proposed: number) =>
  presentOwnerFlag(years(live, proposed)).vsCurrent[0]!;

describe("presentOwnerFlag rounding rules", () => {
  it("(a) 12% more is mark up, euros to the nearest 100, percent to the nearest 5", () => {
    expect(firstCell(10_000, 11_200)).toEqual({
      year: 1,
      mark: "up",
      euros: 1200,
      percent: 10,
      over20: false
    });
  });

  it("(a) rounds half away from zero (1250 -> 1300, 12.5% -> 15)", () => {
    const cell = firstCell(10_000, 11_250);
    expect(cell.euros).toBe(1300);
    expect(cell.percent).toBe(15);
    const down = firstCell(10_000, 8_750);
    expect(down.mark).toBe("down");
    expect(down.euros).toBe(-1300);
    expect(down.percent).toBe(-15);
  });

  it("(b) under 2% is same with no euros and no percent", () => {
    expect(firstCell(10_000, 10_100)).toEqual({
      year: 1,
      mark: "same",
      euros: null,
      percent: null,
      over20: false
    });
  });

  it("(b) exactly 2% is no longer same", () => {
    expect(firstCell(10_000, 10_200).mark).toBe("up");
    expect(firstCell(10_000, 9_800).mark).toBe("down");
    expect(firstCell(10_000, 10_199).mark).toBe("same");
  });

  it("(c) more than 20% sets over20, exactly 20% does not", () => {
    expect(firstCell(10_000, 13_000).over20).toBe(true);
    expect(firstCell(10_000, 7_000).over20).toBe(true);
    expect(firstCell(10_000, 12_000).over20).toBe(false);
  });

  it("(d) a baseline under 500 has no percent and marks by |delta| >= 100", () => {
    const up = firstCell(300, 450);
    expect(up.mark).toBe("up");
    expect(up.percent).toBeNull();
    expect(up.euros).toBe(200); // 150 rounds half away from zero to 200
    expect(up.over20).toBe(false);

    const same = firstCell(300, 350);
    expect(same).toEqual({ year: 1, mark: "same", euros: null, percent: null, over20: false });

    expect(firstCell(300, 200).mark).toBe("down");
    expect(firstCell(300, 399).mark).toBe("same");
    expect(firstCell(300, 400).mark).toBe("up");
  });

  it("(d) a baseline of exactly 500 does use the percent", () => {
    const cell = firstCell(500, 600);
    expect(cell.mark).toBe("up");
    expect(cell.percent).toBe(20);
    expect(cell.over20).toBe(false);
  });

  it("(e) a negative baseline divides by its absolute value", () => {
    const cell = firstCell(-2_000, -1_000);
    expect(cell.mark).toBe("up"); // delta +1000, pct +0.5
    expect(cell.euros).toBe(1000);
    expect(cell.percent).toBe(50);
    expect(cell.over20).toBe(true);

    const worse = firstCell(-2_000, -3_000);
    expect(worse.mark).toBe("down");
    expect(worse.euros).toBe(-1000);
    expect(worse.percent).toBe(-50);
  });

  it("never emits negative zero", () => {
    const flag = presentOwnerFlag(years(10_000, 10_000));
    expect(Object.is(flag.vsCurrent[0]!.euros, -0)).toBe(false);
    // up by the percent rule but rounds to 0 euros / 0 percent
    const tiny = firstCell(1_000, 1_020);
    expect(tiny.mark).toBe("up");
    expect(Object.is(tiny.euros, -0)).toBe(false);
    expect(Object.is(tiny.percent, -0)).toBe(false);
  });
});

describe("presentOwnerFlag signal and recommended comparison", () => {
  const withYear5 = (liveFive: number, proposedFive: number): WhatIfYear[] => [
    { year: 1, liveCumulative: 1_000, proposedCumulative: 5_000, recommendedCumulative: null },
    { year: 2, liveCumulative: 2_000, proposedCumulative: 5_000, recommendedCumulative: null },
    { year: 3, liveCumulative: 3_000, proposedCumulative: 5_000, recommendedCumulative: null },
    { year: 4, liveCumulative: 4_000, proposedCumulative: 5_000, recommendedCumulative: null },
    {
      year: 5,
      liveCumulative: liveFive,
      proposedCumulative: proposedFive,
      recommendedCumulative: null
    }
  ];

  it("(f) the signal is the year-5 mark against the live plan, not earlier years", () => {
    // Years 1-4 are all "up", year 5 decides.
    const good = presentOwnerFlag(withYear5(10_000, 12_600));
    expect(good.signal).toBe("good");
    expect(good.fiveYearEuros).toBe(2600);

    const costsMore = presentOwnerFlag(withYear5(10_000, 7_400));
    expect(costsMore.signal).toBe("costs-more");
    expect(costsMore.fiveYearEuros).toBe(-2600);

    const similar = presentOwnerFlag(withYear5(10_000, 10_050));
    expect(similar.signal).toBe("similar");
    expect(similar.fiveYearEuros).toBeNull();
    expect(similar.vsCurrent[4]!.mark).toBe("same");
    expect(similar.vsCurrent[0]!.mark).toBe("up");
  });

  it("returns status ok and one cell per year in order", () => {
    const flag = presentOwnerFlag(years(10_000, 11_200));
    expect(flag.status).toBe("ok");
    expect(flag.vsCurrent.map((c) => c.year)).toEqual([1, 2, 3, 4, 5]);
  });

  it("vsRecommended is null when any recommendedCumulative is null", () => {
    expect(presentOwnerFlag(years(10_000, 11_200, null)).vsRecommended).toBeNull();
    const partial = years(10_000, 11_200, 10_500);
    partial[2] = { ...partial[2]!, recommendedCumulative: null };
    expect(presentOwnerFlag(partial).vsRecommended).toBeNull();
  });

  it("vsRecommended compares proposed against the recommended plan with the same rules", () => {
    const flag = presentOwnerFlag(years(10_000, 11_200, 12_000));
    expect(flag.vsRecommended).not.toBeNull();
    expect(flag.vsRecommended![0]).toEqual({
      year: 1,
      mark: "down", // 11200 vs 12000: -800, -6.67%
      euros: -800,
      percent: -5,
      over20: false
    });
    // signal still uses the live plan
    expect(flag.signal).toBe("good");
  });

  it("throws on an empty series instead of inventing a flag", () => {
    expect(() => presentOwnerFlag([])).toThrow();
  });
});

describe("presentOwnerFlag leaks nothing exact", () => {
  it("(g) no forbidden key names and no exact input number in the output", () => {
    const input: WhatIfYear[] = [
      { year: 1, liveCumulative: 9_871, proposedCumulative: 11_237, recommendedCumulative: 10_943 },
      { year: 2, liveCumulative: 9_872, proposedCumulative: 11_238, recommendedCumulative: 10_944 },
      { year: 3, liveCumulative: 9_873, proposedCumulative: 11_239, recommendedCumulative: 10_945 },
      { year: 4, liveCumulative: 9_874, proposedCumulative: 11_241, recommendedCumulative: 10_946 },
      { year: 5, liveCumulative: 9_875, proposedCumulative: 11_242, recommendedCumulative: 10_947 }
    ];
    const json = JSON.stringify(presentOwnerFlag(input));
    for (const word of ["live", "recommendedCumulative", "proposedCumulative", "cost"]) {
      expect(json.toLowerCase()).not.toContain(word.toLowerCase());
    }
    for (const exact of input.flatMap((y) => [
      y.liveCumulative,
      y.proposedCumulative,
      y.recommendedCumulative as number
    ])) {
      expect(json).not.toContain(String(exact));
    }
    // Every euro is a multiple of 100 and every percent a multiple of 5.
    const flag = presentOwnerFlag(input);
    const cells = [...flag.vsCurrent, ...(flag.vsRecommended ?? [])];
    for (const c of cells) {
      if (c.euros !== null) expect(c.euros % 100).toBe(0);
      if (c.percent !== null) expect(c.percent % 5).toBe(0);
    }
    expect(flag.fiveYearEuros === null || flag.fiveYearEuros % 100 === 0).toBe(true);
    expect(Object.keys(flag).sort()).toEqual(
      ["fiveYearEuros", "signal", "status", "vsCurrent", "vsRecommended"].sort()
    );
    expect(Object.keys(flag.vsCurrent[0]!).sort()).toEqual(
      ["euros", "mark", "over20", "percent", "year"].sort()
    );
  });

  it("does not mutate its input", () => {
    const input = years(10_000, 11_200, 10_500);
    const copy = structuredClone(input);
    presentOwnerFlag(input);
    presentAdminFlag(input, { clients: 100, ticket: 40 }, null);
    expect(input).toEqual(copy);
  });
});

describe("presentAdminFlag", () => {
  it("(h) keeps exact whole euros and a one-decimal percent", () => {
    const input: WhatIfYear[] = [
      {
        year: 1,
        liveCumulative: 10_000,
        proposedCumulative: 11_237.4,
        recommendedCumulative: 10_943.6
      },
      {
        year: 2,
        liveCumulative: 20_000,
        proposedCumulative: 21_000,
        recommendedCumulative: 20_500
      },
      {
        year: 3,
        liveCumulative: 30_000,
        proposedCumulative: 31_000,
        recommendedCumulative: 30_500
      },
      {
        year: 4,
        liveCumulative: 40_000,
        proposedCumulative: 41_000,
        recommendedCumulative: 40_500
      },
      { year: 5, liveCumulative: 400, proposedCumulative: 700, recommendedCumulative: 500 }
    ];
    const flag = presentAdminFlag(input, { clients: 120, ticket: 45 }, "Quiero mas margen");
    expect(flag.status).toBe("ok");
    expect(flag.inputs).toEqual({ clients: 120, ticket: 45 });
    expect(flag.reason).toBe("Quiero mas margen");
    expect(flag.years).toHaveLength(5);

    const y1 = flag.years[0]!;
    expect(y1.live).toBe(10_000);
    expect(y1.proposed).toBe(11_237);
    expect(y1.recommended).toBe(10_944);
    expect(y1.vsLive).toEqual({ year: 1, euros: 1237, percent: 12.4 }); // 12.374 -> 12.4
    expect(y1.vsRecommended).toEqual({ year: 1, euros: 294, percent: 2.7 }); // 293.8 / 10943.6

    // baseline under 500: exact euros, percent null
    const y5 = flag.years[4]!;
    expect(y5.vsLive).toEqual({ year: 5, euros: 300, percent: null });
    expect(y5.vsRecommended).toEqual({ year: 5, euros: 200, percent: 40 });
  });

  it("negative deltas keep their sign, rounding half away from zero", () => {
    const flag = presentAdminFlag(years(10_000, 9_875.5), { clients: 1, ticket: 1 }, null);
    expect(flag.years[0]!.vsLive).toEqual({ year: 1, euros: -125, percent: -1.2 });
    expect(Object.is(flag.years[0]!.vsLive.euros, -0)).toBe(false);
    expect(flag.reason).toBeNull();
  });

  it("recommended and vsRecommended are null per year when the plan is missing", () => {
    const flag = presentAdminFlag(years(10_000, 11_000, null), { clients: 1, ticket: 1 }, null);
    for (const y of flag.years) {
      expect(y.recommended).toBeNull();
      expect(y.vsRecommended).toBeNull();
    }
  });
});
