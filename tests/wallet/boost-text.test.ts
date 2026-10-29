import { describe, expect, it } from "vitest";

import { boostText, referralText } from "../../src/wallet/engine/boost-text";
import { buildStoreCardFields } from "../../src/wallet/providers/apple/apple-pass.fields";
import {
  PASS_LABELS,
  PASS_TRANSLATIONS
} from "../../src/wallet/providers/apple/apple-pass.strings";
import { rewardsPass } from "../fixtures/loyalty-card.fixture";
import type { LoyaltyCard } from "../../src/wallet/engine/loyalty-card";

const perk: LoyaltyCard = {
  ...rewardsPass,
  boost: { kind: "perk", until: "2026-09-12T10:00:00.000Z" }
};
const referral: LoyaltyCard = { ...rewardsPass, boost: { kind: "referral" } };

describe("the boost text, shared by both wallets", () => {
  it("says the next visit doubles and when the perk lapses, in the Madrid date, 'sept' style", () => {
    expect(boostText(perk)).toBe(
      "Tu próxima visita suma el doble de puntos. Válido hasta el 12 sept."
    );
  });

  it("uses the Madrid day, not UTC, for a perk that lapses just before midnight UTC", () => {
    expect(
      boostText({ ...perk, boost: { kind: "perk", until: "2026-09-12T22:30:00.000Z" } })
    ).toContain("hasta el 13 sept.");
  });

  it("says the first visit doubles for a referred member, with no date", () => {
    expect(boostText(referral)).toBe("Tu primera visita suma el doble de puntos.");
  });

  it("has no text without a boost", () => {
    expect(boostText(rewardsPass)).toBeUndefined();
  });

  it("falls back to the plain sentence for a perk with no date", () => {
    expect(boostText({ ...rewardsPass, boost: { kind: "perk" } })).toBe(
      "Tu próxima visita suma el doble de puntos."
    );
  });
});

describe("the boost on the back of the Apple pass", () => {
  const field = (card: LoyaltyCard) =>
    buildStoreCardFields(card).backFields.find((f) => f.key === "boost");

  it("is a back field labelled PUNTOS DOBLES with the shared text and no lock-screen message", () => {
    const f = field(perk);

    expect(f).toMatchObject({
      key: "boost",
      label: "PUNTOS DOBLES",
      value: "Tu próxima visita suma el doble de puntos. Válido hasta el 12 sept."
    });
    expect(f).not.toHaveProperty("changeMessage");
  });

  it("is translated to English", () => {
    expect(PASS_LABELS.boost).toBe("PUNTOS DOBLES");
    expect(PASS_TRANSLATIONS.en["PUNTOS DOBLES"]).toBe("DOUBLE POINTS");
  });

  it("is absent for a card with no boost", () => {
    expect(field(rewardsPass)).toBeUndefined();
  });

  it("keeps every key unique", () => {
    const keys = buildStoreCardFields(referral).backFields.map((f) => f.key);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

const shared: LoyaltyCard = {
  ...rewardsPass,
  referral: { code: "AB2CD", url: "https://voone.app/alta/clinica-aurea?ref=AB2CD" }
};

describe("the referral text, shared by both wallets", () => {
  it("names the code and the link", () => {
    expect(referralText(shared)).toBe(
      "Tu código: AB2CD. Comparte este enlace: https://voone.app/alta/clinica-aurea?ref=AB2CD"
    );
  });

  it("has no text without a referral", () => {
    expect(referralText(rewardsPass)).toBeUndefined();
  });
});

describe("the referral on the back of the Apple pass", () => {
  const field = (card: LoyaltyCard) =>
    buildStoreCardFields(card).backFields.find((f) => f.key === "referral");

  it("is a back field labelled RECOMIENDA, with the link tappable", () => {
    expect(field(shared)).toMatchObject({
      key: "referral",
      label: "RECOMIENDA",
      value:
        "Tu código: AB2CD. Comparte este enlace: https://voone.app/alta/clinica-aurea?ref=AB2CD",
      attributedValue:
        "Tu código: AB2CD. Comparte este enlace: <a href='https://voone.app/alta/clinica-aurea?ref=AB2CD'>https://voone.app/alta/clinica-aurea?ref=AB2CD</a>"
    });
    expect(field(shared)).not.toHaveProperty("changeMessage");
  });

  it("is translated to English", () => {
    expect(PASS_LABELS.referral).toBe("RECOMIENDA");
    expect(PASS_TRANSLATIONS.en.RECOMIENDA).toBe("REFER A FRIEND");
  });

  it("is absent for a card with no referral, and keeps every key unique with all the fields", () => {
    expect(field(rewardsPass)).toBeUndefined();

    const keys = buildStoreCardFields({ ...shared, boost: { kind: "referral" } }).backFields.map(
      (f) => f.key
    );

    expect(new Set(keys).size).toBe(keys.length);
  });
});
