import { describe, expect, it } from "vitest";

import { loyaltyCardSchema } from "../../src/wallet/engine/loyalty-card";
import { fitTierBenefits, tierBenefitsText } from "../../src/wallet/engine/tier-benefits-text";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

describe("fitTierBenefits", () => {
  it("keeps a short list as it is", () => {
    expect(fitTierBenefits("Plata", ["Uno", "Dos"])).toEqual(["Uno", "Dos"]);
  });

  it("drops blank lines and trims the rest", () => {
    expect(fitTierBenefits("Plata", ["  Uno  ", "", "   ", "Dos"])).toEqual(["Uno", "Dos"]);
  });

  it("gives nothing for a list with nothing in it", () => {
    expect(fitTierBenefits("Plata", ["", "  "])).toEqual([]);
  });

  it("cuts a line by code points to 120, never through an emoji", () => {
    const [line] = fitTierBenefits("Plata", [`${"a".repeat(118)}🎁🎁🎁`]);

    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("drops lines from the end, saying how many, until the text fits 500 characters", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1} ${"B".repeat(100)}`);
    const fitted = fitTierBenefits("Diamante", lines);
    const shown = fitted.length - 1;

    expect(fitted.at(-1)).toBe(`… y ${10 - shown} más`);
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThan(10);
    expect(
      tierBenefitsText({ tierBenefits: { tier: "Diamante", lines: fitted } })?.length
    ).toBeLessThanOrEqual(500);
  });

  it("never returns more than 12 lines, the overflow line included", () => {
    const fitted = fitTierBenefits(
      "Oro",
      Array.from({ length: 30 }, (_, i) => `b${i}`)
    );

    expect(fitted.length).toBeLessThanOrEqual(12);
    expect(fitted.at(-1)).toBe(`… y ${30 - (fitted.length - 1)} más`);
  });

  it("produces a list the card schema accepts", () => {
    const fitted = fitTierBenefits(
      "Diamante",
      Array.from({ length: 20 }, () => "x".repeat(300))
    );
    const parsed = loyaltyCardSchema.safeParse({
      ...aureaGoldPass,
      tierBenefits: { tier: "Diamante", lines: fitted }
    });

    expect(parsed.success).toBe(true);
  });
});

describe("tierBenefitsText", () => {
  it("is the tier name, then one bulleted line per benefit", () => {
    expect(tierBenefitsText({ tierBenefits: { tier: "Plata", lines: ["Uno", "Dos"] } })).toBe(
      "Plata\n• Uno\n• Dos"
    );
  });

  it("does not bullet the overflow line", () => {
    expect(tierBenefitsText({ tierBenefits: { tier: "Plata", lines: ["Uno", "… y 3 más"] } })).toBe(
      "Plata\n• Uno\n… y 3 más"
    );
  });

  it("is undefined without tier benefits", () => {
    expect(tierBenefitsText({})).toBeUndefined();
  });
});

describe("the card schema", () => {
  const withBenefits = (tierBenefits: unknown) =>
    loyaltyCardSchema.safeParse({ ...aureaGoldPass, tierBenefits });

  it("accepts a card with tier benefits and a card without", () => {
    expect(withBenefits({ tier: "Plata", lines: ["Uno"] }).success).toBe(true);
    expect(withBenefits(undefined).success).toBe(true);
  });

  it("refuses a tier over 40 characters, more than 12 lines, or a line over 120", () => {
    expect(withBenefits({ tier: "T".repeat(41), lines: ["Uno"] }).success).toBe(false);
    expect(
      withBenefits({ tier: "Plata", lines: Array.from({ length: 13 }, () => "x") }).success
    ).toBe(false);
    expect(withBenefits({ tier: "Plata", lines: ["x".repeat(121)] }).success).toBe(false);
  });
});
