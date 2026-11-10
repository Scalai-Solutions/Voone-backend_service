import { describe, expect, it } from "vitest";

import { fingerprintOf } from "./fingerprint-helper";
import { loyaltyCardSchema, type LoyaltyCard } from "../../src/wallet/engine/loyalty-card";
import { savingsText } from "../../src/wallet/engine/savings-text";
import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import { PASS_LABELS } from "../../src/wallet/providers/apple/apple-pass.strings";
import { buildClassTemplateInfo } from "../../src/wallet/providers/google/classService";
import { rewardsPass } from "../fixtures/loyalty-card.fixture";

const saved = (cents: number): LoyaltyCard => ({
  ...rewardsPass,
  savings: { cents, currency: "EUR" }
});

describe("the savings text", () => {
  it("prints whole euros without cents and others with two decimals", () => {
    expect(savingsText(saved(12000))).toBe("120 €");
    expect(savingsText(saved(12345))).toBe("123,45 €");
    expect(savingsText(saved(5))).toBe("0,05 €");
  });

  it("says nothing while nothing has been saved", () => {
    expect(savingsText(rewardsPass)).toBeUndefined();
  });
});

describe("the savings on the card", () => {
  it("is optional and never a zero", () => {
    expect(loyaltyCardSchema.safeParse({ ...rewardsPass }).success).toBe(true);
    expect(loyaltyCardSchema.safeParse(saved(12000)).success).toBe(true);
    expect(loyaltyCardSchema.safeParse(saved(0)).success).toBe(false);
  });

  it("is a front cell on the Apple pass, in euros, once there is something saved", () => {
    const { secondaryFields, backFields } = buildStoreCardFields(saved(12345));
    const cell = secondaryFields.find((f) => f.key === "savings");

    expect(cell).toMatchObject({
      label: PASS_LABELS.savings,
      value: 123.45,
      currencyCode: "EUR"
    });
    expect(backFields.some((f) => f.key === "savings")).toBe(false);
  });

  it("is not on the Apple pass at all until the first saving", () => {
    const keys = Object.values(buildStoreCardFields(rewardsPass)).flatMap((fields) =>
      (fields as Array<{ key: string }>).map((f) => f.key)
    );

    expect(keys).not.toContain("savings");
  });

  it("makes a card with a saving differ from the same card without, so it syncs", () => {
    expect(fingerprintOf(saved(12000))).not.toBe(fingerprintOf(rewardsPass));
    expect(fingerprintOf(saved(12000))).not.toBe(fingerprintOf(saved(12100)));
  });

  it("has a cell on the front of the Google card beside the rewards count", () => {
    const rows = buildClassTemplateInfo()?.cardTemplateOverride?.cardRowTemplateInfos ?? [];
    const paths = JSON.stringify(rows);

    expect(paths).toContain("object.textModulesData['rewards_count']");
    expect(paths).toContain("object.textModulesData['savings']");
  });
});
