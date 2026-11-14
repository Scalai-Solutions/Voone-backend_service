import { describe, expect, it } from "vitest";

import { applyBenefitOverrides, NO_VISIBLE_LINE } from "../../src/modules/onboarding/benefit-lines";
import { realThresholds, run } from "../../src/modules/onboarding/engine";
import { TIER_BENEFITS, tierBenefitOf } from "../../src/modules/onboarding/engine.config";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { tierRulesSchema } from "../../src/modules/onboarding/onboarding.schema";
import { presentProgram } from "../../src/modules/onboarding/presentation";
import { applyTierRules, type TierRulesChange } from "../../src/modules/onboarding/tier-rules";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { birthdayGiftFor } from "../../src/modules/notifications/automations/member-rewards";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * A tier's REAL rules (multiplier, cosmetics discount, birthday gift) set by the centre.
 *
 * Pure tests, no database. They pin that a programme without `tierRules` behaves exactly as the
 * config says (every programme published before this existed), that a rule set by the centre is
 * what the runtime, the lines and the birthday message all read, and that the sentence never
 * contradicts the value.
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

const ok = (
  program: Program,
  tier: Parameters<typeof applyTierRules>[1],
  change: TierRulesChange
) => {
  const result = applyTierRules(program, tier, change);

  if (!result.ok) throw new Error(result.reason);

  return result.program;
};

const tierOf = (program: Program, key: string) =>
  presentProgram(program, { forAdmin: true }).tiers.find((t) => t.key === key)!;

const viewTier = (program: Program, key: string) =>
  programView(program).tiers.find((t) => t.key === key)!;

describe("tier rules: backward compatibility", () => {
  it("reads the config for a programme without tierRules", () => {
    const program = fresh();

    expect(program.tierRules).toBeUndefined();

    for (const key of Object.keys(TIER_BENEFITS) as Array<keyof typeof TIER_BENEFITS>) {
      expect(tierBenefitOf(key, program.tierRules)).toEqual(TIER_BENEFITS[key]);
      expect(viewTier(program, key).multiplier).toBe(TIER_BENEFITS[key].mult);
      expect(viewTier(program, key).discount).toBe(TIER_BENEFITS[key].discount);
    }
  });

  it("gives realThresholds the same result with no rules as the engine stored", () => {
    const program = fresh();

    expect(realThresholds(program.lad.ms)).toEqual(program.realTh);
    expect(realThresholds(program.lad.ms, undefined)).toEqual(program.realTh);
  });
});

describe("tier rules: multiplier and discount", () => {
  it("is what the runtime applies and what the line says", () => {
    const program = ok(fresh(), "bronce", { mult: 1.5, discount: 0.05 });

    expect(viewTier(program, "bronce").multiplier).toBe(1.5);
    expect(viewTier(program, "bronce").discount).toBe(0.05);
    // Other tiers keep the config.
    expect(viewTier(program, "oro").multiplier).toBe(TIER_BENEFITS.oro.mult);

    const lines = tierOf(program, "bronce").benefits;

    expect(lines).toContain("Cada euro suma ×1,5 de progreso");
    expect(lines.some((l) => l.startsWith("Descuento del 5% en cosmética"))).toBe(true);
    expect(tierOf(program, "bronce").rules).toMatchObject({ multiplier: 1.5, discountPercent: 5 });
  });

  it("stores nothing for a value equal to the config, so the tier keeps following it", () => {
    const raised = ok(fresh(), "oro", { mult: 2 });
    const back = ok(raised, "oro", { mult: TIER_BENEFITS.oro.mult });

    expect(raised.tierRules?.oro?.mult).toBe(2);
    expect(back.tierRules).toBeUndefined();
  });

  it("turns a rule off: ×1 and 0% leave no line", () => {
    const program = ok(fresh(), "platino", { mult: 1, discount: 0 });
    const keys = tierOf(program, "platino").benefitLines.map((l) => l.key);

    expect(keys).not.toContain("mult");
    expect(keys).not.toContain("discount");
    expect(viewTier(program, "platino").discount).toBe(0);
  });

  it("moves every real spend after the tier when its multiplier changes, and nothing before", () => {
    const before = fresh();
    const after = ok(before, "oro", { mult: 2 });
    const oroTramo = 3;

    for (const m of before.lad.ms) {
      if (m.tramo < oroTramo) expect(after.realTh[m.n]).toBeCloseTo(before.realTh[m.n]);
      else expect(after.realTh[m.n]).toBeLessThan(before.realTh[m.n]);
    }

    expect(after.realTh).toEqual(realThresholds(after.lad.ms, after.tierRules));
    expect(after.diamondReal).toBe(after.realTh[after.lad.last.n]);
  });

  it("refuses a value outside the limits", () => {
    expect(applyTierRules(fresh(), "oro", { mult: 3.5 }).ok).toBe(false);
    expect(applyTierRules(fresh(), "oro", { discount: 0.6 }).ok).toBe(false);
  });

  it("clears a reworded or hidden sentence for the value that changed, keeping the others", () => {
    const overridden = applyBenefitOverrides(fresh(), "oro", [
      { key: "discount", text: "Descuento especial" },
      { key: "tests", hidden: true }
    ]);

    if (!overridden.ok) throw new Error(overridden.reason);

    const program = ok(overridden.program, "oro", { discount: 0.2 });

    expect(program.benefitOverrides?.oro?.discount).toBeUndefined();
    expect(program.benefitOverrides?.oro?.tests).toEqual({ hidden: true });
    expect(tierOf(program, "oro").benefits.some((l) => l.startsWith("Descuento del 20%"))).toBe(
      true
    );
  });
});

describe("tier rules: birthday gift", () => {
  it("names a free-text gift on the line and in the birthday message", () => {
    const program = ok(fresh(), "bronce", {
      birthday: { o: { items: [], value: 25, cost: 5 }, name: "Mascarilla de regalo" }
    });

    expect(tierOf(program, "bronce").benefits).toContain(
      "Regalo de cumpleaños: Mascarilla de regalo"
    );
    expect(birthdayGiftFor(program, "Bronce")).toBe("Mascarilla de regalo");
    expect(tierOf(program, "bronce").rules?.birthday).toEqual({
      name: "Mascarilla de regalo",
      priceEuro: 25
    });
  });

  it("removes the gift with null", () => {
    const program = ok(fresh(), "plata", { birthday: null });

    expect(tierOf(program, "plata").benefitLines.map((l) => l.key)).not.toContain("birthday");
    expect(tierOf(program, "plata").rules?.birthday).toBeNull();
  });

  it("never leaves a tier with nothing to show", () => {
    // Bronce's fixed card line hidden, then every real rule turned off.
    const hidden = applyBenefitOverrides(fresh(), "bronce", [{ key: "card", hidden: true }]);

    if (!hidden.ok) throw new Error(hidden.reason);

    expect(applyTierRules(hidden.program, "bronce", { birthday: null })).toEqual({
      ok: false,
      reason: NO_VISIBLE_LINE
    });
  });
});

describe("tier rules: request body", () => {
  it("accepts the limits and refuses what is outside them", () => {
    expect(tierRulesSchema.safeParse({ multiplier: 1.5 }).success).toBe(true);
    expect(tierRulesSchema.safeParse({ discountPercent: 50 }).success).toBe(true);
    expect(tierRulesSchema.safeParse({ birthday: null }).success).toBe(true);
    expect(tierRulesSchema.safeParse({ birthday: { itemId: "x" } }).success).toBe(true);
    expect(
      tierRulesSchema.safeParse({ birthday: { kind: "libre", name: "Regalo", priceEuro: 10 } })
        .success
    ).toBe(true);

    expect(tierRulesSchema.safeParse({}).success).toBe(false);
    expect(tierRulesSchema.safeParse({ multiplier: 1.25 }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ multiplier: 3.1 }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ discountPercent: 5.5 }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ discountPercent: 51 }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ birthday: { kind: "doble" } }).success).toBe(false);
  });
});

describe("tier rules: the edit dialog's free text", () => {
  /** What the dialog prefills: the visible text-only lines, generated ones included. */
  const dialogFreeText = (program: Program, key: string) =>
    tierOf(program, key)
      .benefitLines.filter(
        (l) => !l.hidden && l.key !== "mult" && l.key !== "discount" && l.key !== "birthday"
      )
      .map((l) => l.text);

  it("keeps what clients read when the dialog is saved unchanged", () => {
    const reworded = applyBenefitOverrides(fresh(), "oro", [
      { key: "happyhour", text: "Happy Hour para ti" },
      { key: "tests", hidden: true }
    ]);

    if (!reworded.ok) throw new Error(reworded.reason);

    const before = { ...reworded.program, customBenefits: { oro: ["Café"] } };
    const rules = tierOf(before, "oro").rules!;
    const after = ok(before, "oro", {
      mult: rules.multiplier,
      discount: rules.discountPercent / 100,
      freeText: dialogFreeText(before, "oro")
    });

    expect(tierOf(after, "oro").benefits).toEqual(tierOf(before, "oro").benefits);
    // The text now lives only in the centre's own list.
    expect(after.customBenefits?.oro).toEqual(["Happy Hour para ti", "Café"]);
    expect(
      tierOf(after, "oro")
        .benefitLines.filter((l) => l.kind === "generated" && !l.hidden)
        .map((l) => l.key)
    ).toEqual(expect.arrayContaining(["mult", "discount"]));
  });

  it("replaces the whole list: a removed fixed line is gone, a new point is there", () => {
    const program = ok(fresh(), "plata", { freeText: ["Parking gratis"] });
    const benefits = tierOf(program, "plata").benefits;

    expect(benefits).toContain("Parking gratis");
    expect(benefits.some((b) => b.startsWith("Prioridad en huecos"))).toBe(false);
    // The real lines stay.
    expect(benefits.some((b) => b.startsWith("Descuento del 3%"))).toBe(true);
  });

  it("shows again a real line that was hidden before, because it still applies", () => {
    const hidden = applyBenefitOverrides(fresh(), "oro", [{ key: "birthday", hidden: true }]);

    if (!hidden.ok) throw new Error(hidden.reason);

    const program = ok(hidden.program, "oro", { freeText: dialogFreeText(hidden.program, "oro") });
    const birthday = tierOf(program, "oro").benefitLines.find((l) => l.key === "birthday");

    expect(birthday?.hidden).toBe(false);
  });

  it("refuses a list that leaves the tier empty, storing nothing", () => {
    const bare = ok(fresh(), "bronce", { birthday: null });

    expect(applyTierRules(bare, "bronce", { freeText: [] })).toEqual({
      ok: false,
      reason: NO_VISIBLE_LINE
    });
  });

  it("accepts 10 points of 120 characters and refuses more", () => {
    const line = "x".repeat(120);

    expect(tierRulesSchema.safeParse({ freeText: Array(10).fill(line) }).success).toBe(true);
    expect(tierRulesSchema.safeParse({ freeText: Array(11).fill("a") }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ freeText: ["x".repeat(121)] }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ freeText: [" "] }).success).toBe(false);
    expect(tierRulesSchema.safeParse({ freeText: ["a​b"] }).success).toBe(false);
  });
});
