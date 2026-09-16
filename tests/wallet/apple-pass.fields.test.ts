import { describe, expect, it } from "vitest";

import { loyaltyPassDataSchema } from "../../src/wallet/engine/wallet-pass.schema";
import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import {
  MIN_CONTRAST,
  contrastRatio,
  deriveAppleTheme
} from "../../src/wallet/providers/apple/apple-pass.theme";
import {
  aureaGoldPass,
  brandNewMemberPass,
  fullyPopulatedPass
} from "../fixtures/loyalty-pass.fixture";

const allKeys = (fields: ReturnType<typeof buildStoreCardFields>): string[] =>
  [
    ...fields.headerFields,
    ...fields.primaryFields,
    ...fields.secondaryFields,
    ...fields.auxiliaryFields,
    ...fields.backFields
  ].map((field) => field.key);

describe("buildStoreCardFields", () => {
  it.each([
    ["typical member", aureaGoldPass],
    ["fully populated", fullyPopulatedPass],
    ["brand new member", brandNewMemberPass]
  ])("keeps every key unique across all five slots for a %s", (_label, data) => {
    // A PassType shares one key pool between the slots and throws on a duplicate push, so a
    // collision would only surface as a runtime failure while signing.
    const keys = allKeys(buildStoreCardFields(data));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("takes the points label from the clinic template, not a constant", () => {
    expect(buildStoreCardFields(aureaGoldPass).primaryFields[0]).toMatchObject({
      key: "points",
      label: "Saldo Beauty",
      value: 1250,
      numberStyle: "PKNumberStyleDecimal"
    });
  });

  it("takes the tier label from the clinic template and the value from the member", () => {
    expect(buildStoreCardFields(aureaGoldPass).headerFields[0]).toMatchObject({
      key: "tier",
      label: "Nivel",
      value: "Gold"
    });
  });

  it("puts the programme name and template copy on the back", () => {
    const back = Object.fromEntries(
      buildStoreCardFields(aureaGoldPass).backFields.map((f) => [f.key, f.value])
    );

    expect(back.program).toBe("Clinic Club");
    expect(back.benefits).toContain("Acceso exclusivo");
    expect(back.info).toContain("recepción");
  });

  it("repeats the redemption code and serial on the back as readable fallbacks", () => {
    const back = Object.fromEntries(
      buildStoreCardFields(aureaGoldPass).backFields.map((f) => [f.key, f.value])
    );

    expect(back.redemptionCode).toBe(aureaGoldPass.redemptionCode);
    expect(back.serialNumber).toBe(aureaGoldPass.serialNumber);
  });

  it("omits credit and reward when no column backs them", () => {
    const fields = buildStoreCardFields(aureaGoldPass);

    expect(fields.auxiliaryFields).toHaveLength(0);
    expect(allKeys(fields)).not.toContain("credit");
    expect(allKeys(fields)).not.toContain("reward");
  });

  it("includes them once they are present, converting units correctly", () => {
    const fields = buildStoreCardFields(fullyPopulatedPass);
    const credit = fields.secondaryFields.find((f) => f.key === "credit");
    const progress = fields.auxiliaryFields.find((f) => f.key === "progress");

    // Apple renders currency from a unit amount and multiplies percents by 100.
    expect(credit).toMatchObject({ value: 240, currencyCode: "EUR" });
    expect(progress).toMatchObject({ value: 0.83, numberStyle: "PKNumberStylePercent" });
  });

  it("renders a brand new member as a short card rather than a wrong one", () => {
    const fields = buildStoreCardFields(brandNewMemberPass);

    expect(fields.headerFields).toHaveLength(0);
    expect(fields.primaryFields[0]).toMatchObject({ key: "points", value: 0 });
    expect(fields.secondaryFields.map((f) => f.key)).toEqual(["member"]);
    expect(allKeys(fields)).not.toContain("memberSince");
    expect(allKeys(fields)).not.toContain("benefits");
  });
});

describe("deriveAppleTheme", () => {
  it("uses the clinic's chosen background verbatim", () => {
    expect(deriveAppleTheme("#f1dccd").backgroundColor).toBe("rgb(241, 220, 205)");
  });

  it("picks dark ink on a light background and light ink on a dark one", () => {
    expect(deriveAppleTheme("#f1dccd").foregroundColor).toBe("rgb(43, 33, 28)");
    expect(deriveAppleTheme("#2a2e35").foregroundColor).toBe("rgb(255, 249, 242)");
  });

  it("accepts three digit hex", () => {
    expect(deriveAppleTheme("#fff").backgroundColor).toBe("rgb(255, 255, 255)");
  });

  // The whole point of deriving rather than hardcoding: a clinic can pick anything, and the
  // result still has to be readable. The previous per-tier palette shipped a 2.9:1 label.
  it.each([
    "#ffffff",
    "#000000",
    "#f1dccd",
    "#2a2e35",
    "#ead0bd",
    "#7f7f7f",
    "#808080",
    "#c6a15b",
    "#b06a5a",
    "#3ea36b",
    "#0a84ff"
  ])("clears AA for foreground and label on %s", (background) => {
    const theme = deriveAppleTheme(background);

    expect(contrastRatio(theme.foregroundColor, background)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrastRatio(theme.labelColor, background)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("mutes the label relative to the foreground where contrast allows", () => {
    const theme = deriveAppleTheme("#ffffff");

    expect(theme.labelColor).not.toBe(theme.foregroundColor);
    expect(contrastRatio(theme.labelColor, "#ffffff")).toBeLessThan(
      contrastRatio(theme.foregroundColor, "#ffffff")
    );
  });

  it("falls back to the foreground rather than muting below AA", () => {
    // A mid grey leaves no room to mute, so the label must not be softened at all.
    const theme = deriveAppleTheme("#767676");

    expect(theme.labelColor).toBe(theme.foregroundColor);
  });

  it("accepts its own rgb() output, so a theme can be re-measured", () => {
    const theme = deriveAppleTheme("#f1dccd");

    expect(() => deriveAppleTheme(theme.backgroundColor)).not.toThrow();
  });

  it.each(["papayawhip", "rgb(300, 0, 0)", "#12345", "", "#ggg"])(
    "rejects %o, which is neither hex nor rgb()",
    (value) => {
      expect(() => deriveAppleTheme(value)).toThrow();
    }
  );

  it("clears AA for every background in the colour cube", () => {
    // The guarantee the whole derivation exists for. A clinic can save any colour, and the
    // brand inks alone only reach about 3.9:1 on mid-tones — hence the black/white fallback.
    let worst = Number.POSITIVE_INFINITY;

    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 15) {
        for (let b = 0; b < 256; b += 15) {
          const background = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          const theme = deriveAppleTheme(background);

          worst = Math.min(
            worst,
            contrastRatio(theme.foregroundColor, background),
            contrastRatio(theme.labelColor, background)
          );
        }
      }
    }

    expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });
});

describe("contrastRatio", () => {
  it("matches the known WCAG extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("loyaltyPassDataSchema", () => {
  it.each([
    ["typical", aureaGoldPass],
    ["fully populated", fullyPopulatedPass],
    ["brand new", brandNewMemberPass]
  ])("accepts the %s fixture", (_label, data) => {
    expect(loyaltyPassDataSchema.safeParse(data).success).toBe(true);
  });

  it("accepts any tier string, because Member.tier is free text", () => {
    for (const tier of ["Bronze", "Platinum", "Socia Fundadora", "★"]) {
      expect(loyaltyPassDataSchema.safeParse({ ...aureaGoldPass, tier }).success).toBe(true);
    }
  });

  it("rejects a redemption code that is the serial number", () => {
    const result = loyaltyPassDataSchema.safeParse({
      ...aureaGoldPass,
      redemptionCode: aureaGoldPass.serialNumber
    });

    expect(result.success).toBe(false);
  });

  it("rejects a lowercase redemption code, which is unsafe in some barcode encodings", () => {
    const result = loyaltyPassDataSchema.safeParse({
      ...aureaGoldPass,
      redemptionCode: "mfrggzdfmztwq2lknnwg23q"
    });

    expect(result.success).toBe(false);
  });

  it("rejects a negative point balance", () => {
    expect(loyaltyPassDataSchema.safeParse({ ...aureaGoldPass, points: -1 }).success).toBe(false);
  });

  it("rejects a template background that is not a hex colour", () => {
    const result = loyaltyPassDataSchema.safeParse({
      ...aureaGoldPass,
      template: { ...aureaGoldPass.template, backgroundColor: "papayawhip" }
    });

    expect(result.success).toBe(false);
  });
});
