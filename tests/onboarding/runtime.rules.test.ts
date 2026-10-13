import { describe, expect, it } from "vitest";

import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import { RUNTIME_DECISIONS } from "../../src/modules/onboarding/runtime/decisions";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import {
  bonoSessionCents,
  checkRedemption,
  discountAllowance,
  discountWindowStart,
  earningCents,
  includesTreatment,
  isInSurprisePool,
  milestonesCrossed,
  nextRewardFor,
  purchaseProgress,
  recalibrationAdvice,
  recurringCrossed,
  referralRewardAt,
  resolveTier,
  rewardExpiry,
  sameIdentity,
  tenureMonths,
  tierKeyOf
} from "../../src/modules/onboarding/runtime/rules";
import catalog from "./reference/sapphira.catalogo.json";

/**
 * The runtime rules, against the Sapphira programme.
 *
 * Every rule is exercised at the boundary where a plausible implementation would be wrong:
 * a tenure one day short, a member sitting exactly on a threshold, a payment at 23:30 in
 * Madrid that is already tomorrow in UTC. The programme is the real one the guide publishes
 * numbers for, so the thresholds below are the guide's own — 190, 490, 950, 1660.
 */
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

const view = programView(program());
const tier = (key: string) => view.tiers.find((t) => t.key === key)!;
const at = (iso: string) => new Date(iso);

describe("programView", () => {
  it("reads the tier floors straight off the ladder", () => {
    expect(view.tiers.map((t) => [t.key, t.floor])).toEqual([
      ["bronce", 0],
      ["plata", 190],
      ["oro", 490],
      ["platino", 950],
      ["diamante", 1660]
    ]);
  });

  it("carries the multipliers, tenures and discounts the guide fixes", () => {
    expect(view.tiers.map((t) => t.multiplier)).toEqual([1.0, 1.0, 1.1, 1.2, 1.3]);
    expect(view.tiers.map((t) => t.minTenureMonths)).toEqual([0, 0, 12, 24, 36]);
    expect(view.tiers.map((t) => t.discount)).toEqual([0, 0.03, 0.05, 0.1, 0.15]);
  });

  it("issues nothing for a tier milestone", () => {
    // "Entering a tier grants no gift. It activates that tier's permanent benefits."
    for (const m of view.milestones.filter((x) => x.type === "nivel")) {
      expect(m.issue, `milestone ${m.n}`).toBeUndefined();
    }
  });

  it("describes the recurring reward and the welcome progress", () => {
    expect(view.recurring).toMatchObject({ every: 250, startsAt: 1660 });
    expect(view.welcome).toBe(15);
    expect(view.referral.map((r) => r.n)).toEqual([1, 3, 5, 7, 10]);
  });
});

describe("tierKeyOf", () => {
  it("reads the display name Member.tier stores", () => {
    expect(tierKeyOf("Oro")).toBe("oro");
    expect(tierKeyOf("PLATINO")).toBe("platino");
    expect(tierKeyOf(" Diamante ")).toBe("diamante");
  });

  it("reads a legacy English tier as no tier, not a wrong one", () => {
    // A clinic that has not adopted a programme still has "Gold" on its members. Treating
    // that as Bronce would silently re-tier them.
    expect(tierKeyOf("Gold")).toBeNull();
    expect(tierKeyOf(null)).toBeNull();
    expect(tierKeyOf(undefined)).toBeNull();
    expect(tierKeyOf("")).toBeNull();
  });
});

describe("tenureMonths", () => {
  it("counts whole months and not a day early", () => {
    expect(tenureMonths(at("2026-01-15T12:00:00Z"), at("2026-02-14T12:00:00Z"))).toBe(0);
    expect(tenureMonths(at("2026-01-15T12:00:00Z"), at("2026-02-15T12:00:00Z"))).toBe(1);
  });

  it("crosses a year boundary", () => {
    expect(tenureMonths(at("2025-11-20T12:00:00Z"), at("2026-11-20T12:00:00Z"))).toBe(12);
    expect(tenureMonths(at("2025-11-20T12:00:00Z"), at("2026-11-19T12:00:00Z"))).toBe(11);
  });

  it("reads the date in Madrid, not UTC", () => {
    // 23:30 UTC on 31 January is 00:30 on 1 February in Madrid, so the member joined in
    // February and a month later is the 1st of March, not the 28th of February.
    const joined = at("2026-01-31T23:30:00Z");

    expect(tenureMonths(joined, at("2026-02-28T12:00:00Z"))).toBe(0);
    expect(tenureMonths(joined, at("2026-03-01T12:00:00Z"))).toBe(1);
  });

  it("is never negative", () => {
    expect(tenureMonths(at("2026-06-01T12:00:00Z"), at("2026-01-01T12:00:00Z"))).toBe(0);
  });
});

describe("resolveTier", () => {
  const resolve = (progress: number, tenure: number, current: string | null = null) =>
    resolveTier(view, {
      progress,
      tenureMonths: tenure,
      current: tierKeyOf(current)
    });

  it("starts everyone in Bronce", () => {
    expect(resolve(0, 0).tier.key).toBe("bronce");
    expect(resolve(189, 0).tier.key).toBe("bronce");
  });

  it("enters Plata at exactly its threshold", () => {
    expect(resolve(190, 0).tier.key).toBe("plata");
  });

  it("needs tenure as well as progress: enough progress alone is not enough", () => {
    // The point of the gate. 1,700 progress euros is past Diamante's threshold, but six
    // months in the programme is not a Diamante client.
    const r = resolve(1700, 6);

    expect(r.tier.key).toBe("plata");
    expect(r.waitingForTenure?.key).toBe("oro");
  });

  it("enters the tier the day tenure is met, with the progress already banked", () => {
    expect(resolve(1700, 11).tier.key).toBe("plata");
    expect(resolve(1700, 12).tier.key).toBe("oro");
    expect(resolve(1700, 24).tier.key).toBe("platino");
    expect(resolve(1700, 36).tier.key).toBe("diamante");
  });

  it("needs the threshold even when tenure is long", () => {
    expect(resolve(100, 60).tier.key).toBe("bronce");
    expect(resolve(489, 60).tier.key).toBe("plata");
  });

  it("reports nothing to wait for once the top tier is held", () => {
    expect(resolve(5000, 60).waitingForTenure).toBeNull();
  });

  it("reports nothing to wait for when progress is the limit", () => {
    expect(resolve(100, 60).waitingForTenure).toBeNull();
  });

  it("never loses a tier it has held", () => {
    expect(resolve(100, 20, "Oro").tier.key).toBe("oro");
  });

  it("loses one only when a staff correction says so", () => {
    const r = resolveTier(view, {
      progress: 100,
      tenureMonths: 20,
      current: "oro",
      allowDemotion: true
    });

    expect(r.tier.key).toBe("bronce");
  });

  it("does not hold a member BELOW what they have earned", () => {
    expect(resolve(950, 30, "Plata").tier.key).toBe("platino");
  });

  it("treats negative progress as Bronce rather than as no tier", () => {
    expect(resolve(-50, 0).tier.key).toBe("bronce");
  });
});

describe("what earns progress", () => {
  it("excludes pharmacological medicine and medical acts", () => {
    // A legal constraint in Spain. Neither earns progress, whatever was paid.
    expect(
      earningCents([
        { category: "FAC", amountCents: 6000 },
        { category: "MFA", amountCents: 30000 },
        { category: "MNF", amountCents: 9000 }
      ])
    ).toBe(6000);
  });

  it("counts retail, diagnosis and an uncategorised line", () => {
    expect(
      earningCents([
        { category: "COS", amountCents: 2500 },
        { category: "DIA", amountCents: 1000 },
        { amountCents: 4000 }
      ])
    ).toBe(7500);
  });

  it("earns nothing from an empty basket", () => {
    expect(earningCents([])).toBe(0);
  });

  it("calls a visit a treatment unless it was retail only", () => {
    expect(includesTreatment([])).toBe(true);
    expect(includesTreatment([{ category: "COS", amountCents: 2500 }])).toBe(false);
    expect(
      includesTreatment([
        { category: "COS", amountCents: 2500 },
        { category: "FAC", amountCents: 6000 }
      ])
    ).toBe(true);
  });
});

describe("purchaseProgress", () => {
  it("adds one progress euro per euro paid in Bronce and Plata", () => {
    expect(purchaseProgress({ cents: 6500, tier: tier("bronce") })).toBe(65);
    expect(purchaseProgress({ cents: 6500, tier: tier("plata") })).toBe(65);
    expect(purchaseProgress({ cents: 6500, tier: null })).toBe(65);
  });

  it("applies the multiplier of the tier held at the moment of purchase", () => {
    expect(purchaseProgress({ cents: 10000, tier: tier("oro") })).toBe(110);
    expect(purchaseProgress({ cents: 10000, tier: tier("platino") })).toBe(120);
    expect(purchaseProgress({ cents: 10000, tier: tier("diamante") })).toBe(130);
  });

  it("rounds half away from zero, once", () => {
    // 65 x 1.1 = 71.5, which is the case that distinguishes rounding rules.
    expect(purchaseProgress({ cents: 6500, tier: tier("oro") })).toBe(72);
    expect(purchaseProgress({ cents: 6500, tier: tier("diamante") })).toBe(85); // 84.5
  });

  it("doubles the visit, then the multiplier still applies", () => {
    expect(purchaseProgress({ cents: 6500, tier: null, doubled: true })).toBe(130);
    expect(purchaseProgress({ cents: 10000, tier: tier("oro"), doubled: true })).toBe(220);
  });

  it("earns nothing on nothing", () => {
    expect(purchaseProgress({ cents: 0, tier: tier("oro") })).toBe(0);
  });
});

describe("bonoSessionCents", () => {
  it("divides the package price by its sessions", () => {
    expect(bonoSessionCents(30000, 6)).toBe(5000);
    expect(bonoSessionCents(10000, 3)).toBe(3333);
  });

  it("refuses a package with no sessions", () => {
    expect(() => bonoSessionCents(10000, 0)).toThrow(RangeError);
    expect(() => bonoSessionCents(10000, 2.5)).toThrow(RangeError);
  });
});

describe("milestonesCrossed", () => {
  const issued = view.milestones.filter((m) => m.issue);

  it("issues nothing before the first threshold", () => {
    expect(milestonesCrossed(view, 0, 29)).toEqual([]);
  });

  it("issues the first reward on the first visit", () => {
    // The guide's invariant: the first reward is reachable on the first visit.
    const crossed = milestonesCrossed(view, 0, 65);

    expect(crossed.map((m) => m.n)).toEqual([1]);
    expect(crossed[0].issue?.kind).toBe("PREMIO");
  });

  it("issues EVERY milestone a big purchase crosses, not just the highest", () => {
    const crossed = milestonesCrossed(view, 0, 1000);

    expect(crossed.map((m) => m.n)).toEqual(issued.filter((m) => m.th <= 1000).map((m) => m.n));
    expect(crossed.length).toBeGreaterThan(5);
  });

  it("does not re-issue what the member was already sitting on", () => {
    // Open below: standing exactly on a threshold means it was issued before.
    const first = issued[0];

    expect(milestonesCrossed(view, first.th - 1, first.th).map((m) => m.n)).toEqual([first.n]);
    expect(milestonesCrossed(view, first.th, first.th + 1)).toEqual([]);
  });

  it("issues in ladder order", () => {
    const ns = milestonesCrossed(view, 0, 2000).map((m) => m.n);

    expect(ns).toEqual([...ns].sort((a, b) => a - b));
  });

  it("is empty when progress did not move", () => {
    expect(milestonesCrossed(view, 500, 500)).toEqual([]);
  });
});

describe("recurringCrossed", () => {
  it("issues nothing until Diamante's threshold has been passed", () => {
    expect(recurringCrossed(view, 0, 1660)).toEqual([]);
    expect(recurringCrossed(view, 1600, 1909)).toEqual([]);
  });

  it("issues the first one a full interval past the threshold", () => {
    // 1660 + 250. Not at 1660, or everyone would be handed a reward for arriving.
    expect(recurringCrossed(view, 1600, 1910)).toEqual([1]);
  });

  it("issues each repeat it crosses, no more", () => {
    expect(recurringCrossed(view, 1600, 2500)).toEqual([1, 2, 3]);
    expect(recurringCrossed(view, 1910, 1920)).toEqual([]);
    expect(recurringCrossed(view, 1910, 2160)).toEqual([2]);
  });

  it("is bounded, because dozens in one visit is a data error", () => {
    expect(recurringCrossed(view, 0, 1_000_000).length).toBeLessThanOrEqual(50);
  });
});

describe("rewardExpiry", () => {
  it("lapses exactly 60 days after issue", () => {
    const issued = at("2026-10-13T10:00:00Z");

    expect(rewardExpiry(issued).toISOString()).toBe("2026-12-12T10:00:00.000Z");
    expect(RUNTIME_DECISIONS.rewardTtlDays).toBe(60);
  });
});

describe("discountAllowance", () => {
  it("is nothing in a tier with no discount", () => {
    expect(discountAllowance({ tier: tier("bronce"), usedThisWindow: 0 })).toBe(0);
    expect(discountAllowance({ tier: null, usedThisWindow: 0 })).toBe(0);
  });

  it("allows three products a year and counts them down", () => {
    expect(discountAllowance({ tier: tier("plata"), usedThisWindow: 0 })).toBe(3);
    expect(discountAllowance({ tier: tier("oro"), usedThisWindow: 2 })).toBe(1);
    expect(discountAllowance({ tier: tier("diamante"), usedThisWindow: 3 })).toBe(0);
  });

  it("never goes negative when a correction left more used than allowed", () => {
    expect(discountAllowance({ tier: tier("plata"), usedThisWindow: 7 })).toBe(0);
  });

  it("resets on 1 January in Madrid, not in UTC", () => {
    // Midnight on 1 January in Madrid is 23:00 UTC on the 31st. A purchase in that hour
    // belongs to the new year for the clinic and the old one for a UTC reading.
    expect(discountWindowStart(at("2026-06-15T12:00:00Z")).toISOString()).toBe(
      "2025-12-31T23:00:00.000Z"
    );
    expect(discountWindowStart(at("2027-01-01T00:30:00Z")).toISOString()).toBe(
      "2026-12-31T23:00:00.000Z"
    );
  });
});

describe("referralRewardAt", () => {
  it("rewards the 1st, 3rd, 5th, 7th and 10th referral", () => {
    for (const n of [1, 3, 5, 7, 10]) {
      expect(referralRewardAt(view, n), `referral ${n}`).toMatchObject({
        sourceKey: `ref:${n}`,
        step: n
      });
    }
  });

  it("rewards nothing in between", () => {
    for (const n of [0, 2, 4, 6, 8, 9, 11, 12]) {
      expect(referralRewardAt(view, n), `referral ${n}`).toBeNull();
    }
  });

  it("repeats the tenth reward every three referrals after it", () => {
    // The 13th, 16th, 19th. And each gets its own key, so none is mistaken for the 10th.
    for (const n of [13, 16, 19, 22]) {
      expect(referralRewardAt(view, n), `referral ${n}`).toMatchObject({
        sourceKey: `ref:${n}`,
        step: 10
      });
    }

    expect(referralRewardAt(view, 14)).toBeNull();
    expect(referralRewardAt(view, 15)).toBeNull();
  });
});

describe("sameIdentity", () => {
  it("matches the same record, phone or email", () => {
    expect(sameIdentity({ id: "a" }, { id: "a" })).toBe(true);
    expect(sameIdentity({ phone: "+34612345678" }, { phone: "+34612345678" })).toBe(true);
    expect(sameIdentity({ email: "A@x.com " }, { email: "a@X.com" })).toBe(true);
  });

  it("does not match different people", () => {
    expect(
      sameIdentity({ id: "a", phone: "+34600000001" }, { id: "b", phone: "+34600000002" })
    ).toBe(false);
  });

  it("does not treat two missing values as a match", () => {
    // Two members with no email are not the same person.
    expect(sameIdentity({ id: "a", email: null }, { id: "b", email: null })).toBe(false);
    expect(sameIdentity({ phone: null }, { phone: null })).toBe(false);
  });
});

describe("checkRedemption", () => {
  const now = at("2026-10-13T10:00:00Z");
  const reward = {
    clinicId: "c1",
    memberId: "m1",
    redeemedAt: null,
    expiresAt: at("2026-12-12T10:00:00Z")
  };
  const visit = { clinicId: "c1", memberId: "m1", occurredAt: at("2026-10-13T08:00:00Z") };

  it("allows a redemption against a visit from today", () => {
    expect(checkRedemption({ reward, visit, now })).toEqual({ ok: true });
  });

  it("refuses with no visit at all", () => {
    // The guide's rule, and the reason PaidVisit exists. It is enforced by what the
    // database can show, not by a flag the caller asserts.
    const verdict = checkRedemption({ reward, visit: null, now });

    expect(verdict).toMatchObject({ ok: false, reason: "sin_visita_de_pago" });
  });

  it("refuses a reward already redeemed", () => {
    expect(
      checkRedemption({ reward: { ...reward, redeemedAt: at("2026-10-01T10:00:00Z") }, visit, now })
    ).toMatchObject({ ok: false, reason: "ya_canjeado" });
  });

  it("refuses an expired reward, and at the exact instant of expiry", () => {
    // A visit on the same day as `now` each time, so only the expiry is in question.
    const justBefore = at("2026-12-12T09:59:59Z");
    const sameDay = (instant: Date) => ({ ...visit, occurredAt: instant });

    expect(checkRedemption({ reward, visit: sameDay(justBefore), now: justBefore }).ok).toBe(true);
    expect(
      checkRedemption({
        reward,
        visit: sameDay(reward.expiresAt),
        now: reward.expiresAt
      })
    ).toMatchObject({ ok: false, reason: "caducado" });
  });

  it("reports an expired reward as expired even when there is also no visit", () => {
    // The more useful reason first: telling a receptionist "no visit" about a lapsed
    // reward would send them looking for the wrong fix.
    expect(checkRedemption({ reward, visit: null, now: at("2027-01-01T10:00:00Z") })).toMatchObject(
      { ok: false, reason: "caducado" }
    );
  });

  it("refuses a visit that belongs to someone else", () => {
    expect(checkRedemption({ reward, visit: { ...visit, memberId: "m2" }, now })).toMatchObject({
      ok: false,
      reason: "visita_ajena"
    });
    expect(checkRedemption({ reward, visit: { ...visit, clinicId: "c2" }, now })).toMatchObject({
      ok: false,
      reason: "visita_ajena"
    });
  });

  it("refuses a visit from another day", () => {
    expect(
      checkRedemption({ reward, visit: { ...visit, occurredAt: at("2026-10-12T10:00:00Z") }, now })
    ).toMatchObject({ ok: false, reason: "visita_de_otro_dia" });
  });

  it("reads 'the same day' in Madrid, not UTC", () => {
    // 21:30 UTC is 23:30 in Madrid in October; an hour later it is already tomorrow there,
    // though both instants are the same UTC day. The clinic would call these different days.
    const late = { ...visit, occurredAt: at("2026-10-13T21:30:00Z") };

    expect(checkRedemption({ reward, visit: late, now: at("2026-10-13T21:50:00Z") }).ok).toBe(true);
    expect(checkRedemption({ reward, visit: late, now: at("2026-10-13T22:30:00Z") })).toMatchObject(
      {
        ok: false,
        reason: "visita_de_otro_dia"
      }
    );
  });

  it("gives every refusal a Spanish sentence a receptionist can act on", () => {
    const verdict = checkRedemption({ reward, visit: null, now });

    expect(verdict.ok).toBe(false);
    expect((verdict as { message: string }).message).toMatch(/pago|bono/);
  });
});

describe("isInSurprisePool", () => {
  const pool = [{ id: "C1" }, { id: "P2" }];

  it("accepts an item from the pool and nothing else", () => {
    expect(isInSurprisePool(pool, "C1")).toBe(true);
    expect(isInSurprisePool(pool, "F9")).toBe(false);
    expect(isInSurprisePool(undefined, "C1")).toBe(false);
  });
});

describe("recalibrationAdvice", () => {
  const base = {
    usedTicket: 65,
    usedVisits: 5.1,
    measuredTicket: 65,
    measuredVisits: 5.1,
    daysOfData: 120
  };

  it("stays quiet when reality matches the assumptions", () => {
    expect(recalibrationAdvice(base).offer).toBe(false);
  });

  it("offers once either figure drifts past 15%", () => {
    expect(recalibrationAdvice({ ...base, measuredTicket: 80 }).offer).toBe(true); // +23%
    expect(recalibrationAdvice({ ...base, measuredVisits: 3 }).offer).toBe(true); // -41%
  });

  it("does not offer at exactly the threshold", () => {
    expect(recalibrationAdvice({ ...base, usedTicket: 100, measuredTicket: 115 }).offer).toBe(
      false
    );
    expect(recalibrationAdvice({ ...base, usedTicket: 100, measuredTicket: 115.5 }).offer).toBe(
      true
    );
  });

  it("says nothing on under 90 days of data, however far apart", () => {
    const advice = recalibrationAdvice({ ...base, measuredTicket: 200, daysOfData: 60 });

    expect(advice.offer).toBe(false);
    expect(advice.reason).toContain("90");
  });

  it("is prompted, never automatic", () => {
    expect(RUNTIME_DECISIONS.recalibration).toBe("prompted");
  });
});

describe("the decisions the guide left open", () => {
  it("records each provisional answer where it can be found and changed", () => {
    expect(RUNTIME_DECISIONS).toMatchObject({
      tenureStartsAt: "signup",
      discountWindow: "calendar_year",
      progressScope: "per_centre",
      surpriseChosenBy: "staff_from_pool",
      reviewsEarnProgress: false
    });
    expect(RUNTIME_DECISIONS.acceptedVisitSources).toEqual(["STAFF_ENTRY"]);
  });
});

describe("nextRewardFor", () => {
  const issuing = view.milestones.filter((m) => m.issue);

  it("names the first reward to a brand new member", () => {
    const next = nextRewardFor(view, 0)!;

    expect(next).toMatchObject({ remaining: issuing[0].th, percent: 0, source: "milestone" });
    expect(next.title).toBe(issuing[0].issue!.title);
  });

  it("counts the distance in euros and the progress through the step", () => {
    const first = issuing[0]; // th 30
    const next = nextRewardFor(view, 15)!;

    expect(next.remaining).toBe(first.th - 15);
    expect(next.percent).toBe(50);
  });

  it("moves on to the following reward the moment one is crossed", () => {
    const [a, b] = issuing;

    expect(nextRewardFor(view, a.th - 1)!.title).toBe(a.issue!.title);
    expect(nextRewardFor(view, a.th)!.title).toBe(b.issue!.title);
  });

  it("skips a tier-up, which grants nothing, when looking for the next reward", () => {
    // Sitting just below a tier milestone: the next REWARD is still the next one that issues.
    const tierUp = view.milestones.find((m) => m.type === "nivel")!;
    const next = nextRewardFor(view, tierUp.th - 1)!;

    expect(view.milestones.find((m) => m.issue?.title === next.title)!.th).toBeGreaterThan(
      tierUp.th - 1
    );
  });

  it("starts the step after a tier-up at zero, not partway up it", () => {
    // Just past the Plata threshold the member has just entered the tier: their next step
    // begins here, so the bar must read near empty and not carry the previous step's progress.
    const plata = tier("plata").floor;

    expect(nextRewardFor(view, plata)!.percent).toBe(0);
  });

  it("always asks for at least one more euro", () => {
    for (const progress of [0, 29, 30, 249, 1559]) {
      expect(nextRewardFor(view, progress)!.remaining).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the percentage between 0 and 100 everywhere", () => {
    for (let progress = 0; progress <= 4000; progress += 7) {
      const { percent } = nextRewardFor(view, progress)!;

      expect(percent, `at ${progress}`).toBeGreaterThanOrEqual(0);
      expect(percent, `at ${progress}`).toBeLessThanOrEqual(100);
    }
  });

  it("turns to the recurring reward once the ladder's rewards are all earned", () => {
    const lastReward = issuing[issuing.length - 1];
    const next = nextRewardFor(view, lastReward.th)!;

    expect(next.source).toBe("recurring");
    expect(next.title).toBe(view.recurring.title);
  });

  it("does not go negative between the last reward and Diamante", () => {
    // The last issuing milestone sits BELOW Diamante's threshold, so for a stretch the member
    // is past every reward but not yet past the point the recurring one counts from.
    const lastReward = issuing[issuing.length - 1];
    const progress = lastReward.th + 5;

    expect(progress).toBeLessThan(view.recurring.startsAt);
    expect(nextRewardFor(view, progress)!.percent).toBeGreaterThanOrEqual(0);
  });

  it("counts down to each repeat past Diamante", () => {
    const { every, startsAt } = view.recurring;

    expect(nextRewardFor(view, startsAt + 10)!.remaining).toBe(every - 10);
    // One repeat later the target moves out by an interval.
    expect(nextRewardFor(view, startsAt + every + 10)!.remaining).toBe(every - 10);
  });
});
