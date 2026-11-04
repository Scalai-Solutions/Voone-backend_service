import { describe, expect, it } from "vitest";

import { run } from "../../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../../src/modules/onboarding/engine.types";
import { itemsTitle } from "../../../src/modules/onboarding/reward-title";
import {
  GENERIC_BIRTHDAY_GIFT,
  birthdayGiftFor,
  nextReferralReward
} from "../../../src/modules/notifications/automations/member-rewards";
import catalog from "../../onboarding/reference/sapphira.catalogo.json";

const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const program = (): Program => {
  const result = run(catalog as CatalogItem[], ANSWERS);

  if (isEngineError(result)) throw new Error(result.error);

  return result;
};

const stepTitle = (p: Program, n: number): string => {
  const step = p.refLad.find((candidate) => candidate.n === n);

  if (!step) throw new Error(`no referral step ${n}`);

  return step.name;
};

describe("nextReferralReward", () => {
  const p = program();

  it("is the first rung for a member with no counted referrals", () => {
    expect(nextReferralReward(p, 0)).toBe(stepTitle(p, 1));
  });

  it("skips the referrals that earn nothing: after the 1st comes the 3rd", () => {
    expect(nextReferralReward(p, 1)).toBe(stepTitle(p, 3));
    expect(nextReferralReward(p, 2)).toBe(stepTitle(p, 3));
  });

  it("moves up the ladder as referrals count", () => {
    expect(nextReferralReward(p, 3)).toBe(stepTitle(p, 5));
    expect(nextReferralReward(p, 7)).toBe(stepTitle(p, 10));
  });

  it("repeats the last rung after the ladder ends", () => {
    expect(nextReferralReward(p, 10)).toBe(stepTitle(p, 10));
    expect(nextReferralReward(p, 40)).toBe(stepTitle(p, 10));
  });
});

describe("birthdayGiftFor", () => {
  const p = program();

  it("is the gift the programme assigns to the member's tier", () => {
    const gift = p.gifts.oro.birthday;

    expect(gift).toBeDefined();
    expect(birthdayGiftFor(p, "Oro")).toBe(itemsTitle(gift!.items));
  });

  it("treats a member with no tier as Bronce", () => {
    const gift = p.gifts.bronce.birthday;

    expect(birthdayGiftFor(p, null)).toBe(gift ? itemsTitle(gift.items) : GENERIC_BIRTHDAY_GIFT);
  });

  it("falls back to a generic phrase when the tier has no gift or there is no programme", () => {
    const noGift = structuredClone(p);

    delete noGift.gifts.oro.birthday;

    expect(birthdayGiftFor(noGift, "Oro")).toBe(GENERIC_BIRTHDAY_GIFT);
    expect(birthdayGiftFor(null, "Oro")).toBe(GENERIC_BIRTHDAY_GIFT);
  });
});
