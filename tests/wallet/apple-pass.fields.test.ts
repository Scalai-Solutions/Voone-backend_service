import { describe, expect, it } from "vitest";

import { loyaltyCardSchema } from "../../src/wallet/engine/loyalty-card";
import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import {
  MIN_CONTRAST,
  contrastRatio,
  deriveAppleTheme
} from "../../src/wallet/providers/apple/apple-pass.theme";
import {
  aureaGoldPass,
  brandNewMemberPass,
  fullyPopulatedPass,
  rewardsPass,
  uncodedMemberPass
} from "../fixtures/loyalty-card.fixture";
import {
  PASS_LABELS,
  PASS_TRANSLATIONS
} from "../../src/wallet/providers/apple/apple-pass.strings";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";

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
    ["brand new member", brandNewMemberPass],
    ["member with rewards waiting", rewardsPass],
    ["programme member with none", { ...rewardsPass, rewards: { available: [] } }]
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

  it("prints the member's own number on the back, not the pass serial", () => {
    // What reception asks for out loud, and what a member reads off their card. The
    // serial is `voone-member-<uuid>`: 49 characters, and nobody has ever read one out.
    const back = Object.fromEntries(
      buildStoreCardFields(aureaGoldPass).backFields.map((f) => [f.key, f.value])
    );

    expect(back.redemptionCode).toBe(aureaGoldPass.redemptionCode);
    expect(back.memberCode).toBe("K7M2Q");
    expect(back.serialNumber).toBeUndefined();
  });

  it("falls back to the serial for a member the backfill has not reached", () => {
    // Members who signed up before Member.code existed. The long serial is poor, but a
    // card with no identifier on it at all is worse — reception would have nothing to
    // look them up by if the barcode will not scan.
    const back = Object.fromEntries(
      buildStoreCardFields(uncodedMemberPass).backFields.map((f) => [f.key, f.value])
    );

    expect(back.memberCode).toBeUndefined();
    expect(back.serialNumber).toBe(uncodedMemberPass.serialNumber);
  });

  it("never prints both numbers, which would read as two different identities", () => {
    for (const card of [aureaGoldPass, uncodedMemberPass]) {
      const keys = buildStoreCardFields(card).backFields.map((f) => f.key);

      expect(keys.filter((key) => key === "memberCode" || key === "serialNumber")).toHaveLength(1);
    }
  });

  it("omits credit and reward when no column backs them", () => {
    const fields = buildStoreCardFields(aureaGoldPass);

    // The reward row stays empty: no reward or progress is invented.
    expect(fields.auxiliaryFields).toEqual([]);
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

  it("shows the member number on the front, never the long serial", () => {
    expect(buildStoreCardFields(aureaGoldPass).secondaryFields[1]).toMatchObject({
      key: "memberNo",
      value: "K7M2Q"
    });
    expect(buildStoreCardFields(uncodedMemberPass).secondaryFields.map((f) => f.key)).not.toContain(
      "memberNo"
    );
  });

  describe("last message", () => {
    const withMessage = { ...aureaGoldPass, message: { text: "27 oct · Título: cuerpo" } };

    it("adds a back field whose change notifies the member with the message itself", () => {
      const field = buildStoreCardFields(withMessage).backFields.find(
        (f) => f.key === "lastMessage"
      );

      expect(field).toEqual({
        key: "lastMessage",
        label: "ÚLTIMO MENSAJE",
        value: "27 oct · Título: cuerpo",
        changeMessage: "%@"
      });
    });

    it("is absent when the member has no message", () => {
      expect(allKeys(buildStoreCardFields(aureaGoldPass))).not.toContain("lastMessage");
    });

    it("keeps every key unique", () => {
      const keys = allKeys(buildStoreCardFields(withMessage));

      expect(new Set(keys).size).toBe(keys.length);
    });

    it("changes the field value when the same text is sent on a different day", () => {
      const value = (text: string) =>
        buildStoreCardFields({ ...aureaGoldPass, message: { text } }).backFields.find(
          (f) => f.key === "lastMessage"
        )?.value;

      expect(value("27 oct · H: B")).not.toBe(value("28 oct · H: B"));
    });
  });

  it("adds tappable booking and website links only when the template has them", () => {
    const withLinks = {
      ...aureaGoldPass,
      template: {
        ...aureaGoldPass.template,
        appointmentUrl: "https://clinic.example/reservar",
        websiteUrl: "https://clinic.example"
      }
    };
    const back = Object.fromEntries(
      buildStoreCardFields(withLinks).backFields.map((f) => [f.key, f])
    );

    expect(back.book.attributedValue).toContain("href='https://clinic.example/reservar'");
    expect(back.website.attributedValue).toContain("href='https://clinic.example'");
    expect(allKeys(buildStoreCardFields(aureaGoldPass))).not.toContain("book");
  });

  it("renders a brand new member as a short card rather than a wrong one", () => {
    const fields = buildStoreCardFields(brandNewMemberPass);

    expect(fields.headerFields).toHaveLength(0);
    expect(fields.primaryFields[0]).toMatchObject({ key: "points", value: 0 });
    expect(fields.secondaryFields.map((f) => f.key)).toEqual(["member", "memberNo"]);
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

describe("loyaltyCardSchema", () => {
  it.each([
    ["typical", aureaGoldPass],
    ["fully populated", fullyPopulatedPass],
    ["brand new", brandNewMemberPass]
  ])("accepts the %s fixture", (_label, data) => {
    expect(loyaltyCardSchema.safeParse(data).success).toBe(true);
  });

  it("accepts any tier string, because Member.tier is free text", () => {
    for (const tier of ["Bronze", "Platinum", "Miembro Fundador", "★"]) {
      expect(loyaltyCardSchema.safeParse({ ...aureaGoldPass, tier }).success).toBe(true);
    }
  });

  it("rejects a redemption code that is the serial number", () => {
    const result = loyaltyCardSchema.safeParse({
      ...aureaGoldPass,
      redemptionCode: aureaGoldPass.serialNumber
    });

    expect(result.success).toBe(false);
  });

  it("rejects a lowercase redemption code, which is unsafe in some barcode encodings", () => {
    const result = loyaltyCardSchema.safeParse({
      ...aureaGoldPass,
      redemptionCode: "mfrggzdfmztwq2lknnwg23q"
    });

    expect(result.success).toBe(false);
  });

  it("rejects a negative point balance", () => {
    expect(loyaltyCardSchema.safeParse({ ...aureaGoldPass, points: -1 }).success).toBe(false);
  });

  it("rejects a template background that is not a hex colour", () => {
    const result = loyaltyCardSchema.safeParse({
      ...aureaGoldPass,
      template: { ...aureaGoldPass.template, backgroundColor: "papayawhip" }
    });

    expect(result.success).toBe(false);
  });

  describe("next reward cell", () => {
    const withReward = (reward: NonNullable<typeof aureaGoldPass.reward>) => ({
      ...aureaGoldPass,
      reward
    });

    it("carries only the distance when the reward's name is known, and the name goes on the back", () => {
      const fields = buildStoreCardFields(
        withReward({
          description: "Kit de minitallas · te faltan 300 puntos",
          progressPercent: 0,
          title: "Kit de minitallas",
          remainingPoints: 300
        })
      );

      expect(fields.auxiliaryFields.find((f) => f.key === "reward")?.value).toBe("300 puntos");
      expect(fields.auxiliaryFields.find((f) => f.key === "reward")?.label).toBe("FALTAN");
      expect(fields.backFields.find((f) => f.key === "rewardName")?.value).toBe(
        "Kit de minitallas"
      );
    });

    it("keeps the whole description when the name and distance are not known apart", () => {
      const fields = buildStoreCardFields(
        withReward({ description: "Recompensa 2 de 5", progressPercent: 40 })
      );

      expect(fields.auxiliaryFields.find((f) => f.key === "reward")?.value).toBe(
        "Recompensa 2 de 5"
      );
      expect(allKeys(fields)).not.toContain("rewardName");
    });
  });
});

describe("buildStoreCardFields: redeemable rewards", () => {
  const withRewards = (
    available: Array<{ title: string; expiresAt: string }>,
    reward?: LoyaltyCard["reward"]
  ): LoyaltyCard => ({ ...rewardsPass, reward, rewards: { available } });
  const reward = (n: number) => ({
    title: `Premio ${n}`,
    expiresAt: "2026-11-15T10:00:00.000Z"
  });
  const many = (n: number) => Array.from({ length: n }, (_, i) => reward(i + 1));
  const backValue = (data: LoyaltyCard): string =>
    String(buildStoreCardFields(data).backFields.find((f) => f.key === "availableRewards")?.value);

  it("shows a gift count in the header beside the level", () => {
    const { headerFields } = buildStoreCardFields(rewardsPass);

    expect(headerFields.map((f) => f.key)).toEqual(["tier", "rewards"]);
    expect(headerFields[1]).toEqual({
      key: "rewards",
      label: "REGALOS",
      value: "🎁 2",
      textAlignment: "PKTextAlignmentRight",
      changeMessage: "Tus regalos disponibles: %@"
    });
  });

  it("shows 🎁 0 when there is none, so the card reads like a stamp card", () => {
    const { headerFields } = buildStoreCardFields(withRewards([]));

    expect(headerFields.find((f) => f.key === "rewards")?.value).toBe("🎁 0");
  });

  it("keeps the gift count when the member has no tier", () => {
    const { headerFields } = buildStoreCardFields({ ...rewardsPass, tier: undefined });

    expect(headerFields.map((f) => f.key)).toEqual(["rewards"]);
  });

  it("adds neither field for a clinic with no programme", () => {
    const data = { ...rewardsPass, rewards: undefined };
    const fields = buildStoreCardFields(data);

    expect(allKeys(fields)).not.toContain("rewards");
    expect(allKeys(fields)).not.toContain("availableRewards");
  });

  it("lists each reward on the back with its Madrid expiry, then the redemption line", () => {
    expect(backValue(rewardsPass)).toBe(
      [
        "🎁 Limpieza facial · hasta 15 nov",
        "🎁 Kit de minitallas · hasta 20 dic",
        "Preséntalas en el centro para canjearlas."
      ].join("\n")
    );
    expect(
      buildStoreCardFields(rewardsPass).backFields.find((f) => f.key === "availableRewards")?.label
    ).toBe("RECOMPENSAS DISPONIBLES");
  });

  it("dates in Europe/Madrid: 23:30 UTC on 30 Nov is already 1 dic there", () => {
    const text = backValue(withRewards([{ title: "A", expiresAt: "2026-11-30T23:30:00.000Z" }]));

    expect(text).toContain("A · hasta 1 dic");
  });

  it("writes September as sept", () => {
    const text = backValue(withRewards([{ title: "A", expiresAt: "2026-09-12T10:00:00.000Z" }]));

    expect(text).toContain("A · hasta 12 sept");
  });

  it("shows eight lines and counts the rest", () => {
    const text = backValue(withRewards(many(8)));

    expect(text.split("\n").filter((l) => l.startsWith("🎁"))).toHaveLength(8);
    expect(text).not.toContain("más");

    const nine = backValue(withRewards(many(9)));

    expect(nine.split("\n").filter((l) => l.startsWith("🎁"))).toHaveLength(8);
    expect(nine).toContain("… y 1 más");
    expect(nine).not.toContain("Premio 9");
    expect(nine.endsWith("Preséntalas en el centro para canjearlas.")).toBe(true);

    expect(backValue(withRewards(many(20)))).toContain("… y 12 más");
    // The header still counts every one of them.
    expect(buildStoreCardFields(withRewards(many(20))).headerFields.at(-1)?.value).toBe("🎁 20");
  });

  it("with none, says so and names the next reward, with the redemption line after it", () => {
    expect(backValue(withRewards([], rewardsPass.reward))).toBe(
      [
        "Aún no tienes recompensas disponibles. Sérum reparador · te faltan 250 puntos.",
        "Preséntalas en el centro para canjearlas."
      ].join("\n")
    );
  });

  it("with none and no next reward, has no dangling full stop or space", () => {
    expect(backValue(withRewards([]))).toBe(
      "Aún no tienes recompensas disponibles.\nPreséntalas en el centro para canjearlas."
    );
    // A next-reward text that already ends in a full stop is not given a second.
    expect(
      backValue(withRewards([], { description: "Un regalo.", progressPercent: 10 }))
    ).toContain("Un regalo.\n");
  });

  it("is identical on two builds", () => {
    expect(buildStoreCardFields(rewardsPass)).toEqual(buildStoreCardFields(rewardsPass));
  });

  it("has an English translation for the new labels and the change message", () => {
    const english = PASS_TRANSLATIONS.en;

    expect(PASS_LABELS.rewards).toBe("REGALOS");
    expect(english.REGALOS).toBe("GIFTS");
    expect(english["RECOMPENSAS DISPONIBLES"]).toBe("AVAILABLE REWARDS");
    expect(english["Tus regalos disponibles: %@"]).toBe("Your available gifts: %@");
  });
});
