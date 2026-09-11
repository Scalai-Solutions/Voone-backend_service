import { describe, expect, it } from "vitest";

import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import { resolveAppleTheme } from "../../src/wallet/providers/apple/apple-pass.theme";
import { loyaltyPassDataSchema } from "../../src/wallet/engine/wallet-pass.schema";
import { aureaGoldPass } from "../fixtures/loyalty-pass.fixture";

describe("buildStoreCardFields", () => {
  const fields = buildStoreCardFields(aureaGoldPass);

  it("keeps every key unique across all five slots", () => {
    // A PassType shares one key pool between the slots and throws on a duplicate push,
    // so a collision here would only surface as a runtime failure while signing.
    const keys = [
      ...fields.headerFields,
      ...fields.primaryFields,
      ...fields.secondaryFields,
      ...fields.auxiliaryFields,
      ...fields.backFields
    ].map((field) => field.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("passes points through as a number for on-device formatting", () => {
    expect(fields.headerFields[0]).toMatchObject({
      key: "points",
      value: 1250,
      numberStyle: "PKNumberStyleDecimal"
    });
  });

  it("converts cents to a currency unit amount", () => {
    expect(fields.primaryFields[0]).toMatchObject({
      key: "balance",
      value: 240,
      currencyCode: "EUR"
    });
  });

  it("expresses progress as a fraction, because Apple multiplies percents by 100", () => {
    expect(fields.auxiliaryFields[1]).toMatchObject({
      key: "progress",
      value: 0.83,
      numberStyle: "PKNumberStylePercent"
    });
  });

  it("puts the member name and tier on the secondary row", () => {
    expect(fields.secondaryFields.map((field) => field.value)).toEqual([
      "Verónica Navarro",
      "Gold"
    ]);
  });

  it("repeats the redemption code and serial on the back as readable fallbacks", () => {
    const back = Object.fromEntries(fields.backFields.map((field) => [field.key, field.value]));

    expect(back.redemptionCode).toBe(aureaGoldPass.redemptionCode);
    expect(back.serialNumber).toBe(aureaGoldPass.serialNumber);
  });
});

describe("resolveAppleTheme", () => {
  it("flattens each tier to three opaque colours", () => {
    expect(resolveAppleTheme("gold").backgroundColor).toBe("rgb(241, 220, 205)");
    expect(resolveAppleTheme("diamond").backgroundColor).toBe("rgb(42, 46, 53)");
  });
});

describe("loyaltyPassDataSchema", () => {
  it("accepts the reference fixture", () => {
    expect(loyaltyPassDataSchema.safeParse(aureaGoldPass).success).toBe(true);
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
    const result = loyaltyPassDataSchema.safeParse({
      ...aureaGoldPass,
      balance: { ...aureaGoldPass.balance, points: -1 }
    });

    expect(result.success).toBe(false);
  });
});
