import { describe, expect, it } from "vitest";

import {
  bonusPointsSchema,
  createBonoPlanSchema,
  startAtSessionSchema,
  updateBonoPlanSchema
} from "../../src/modules/bonos/bono.schema";
import { visitSchema } from "../../src/modules/onboarding/onboarding.schema";

const VALID_PLAN = { name: "Bono facial", priceEuro: 199.5, totalSessions: 5 };
const KEY = "key-12345678";

describe("createBonoPlanSchema", () => {
  it("accepts a plan and keeps the total price exactly as typed", () => {
    const parsed = createBonoPlanSchema.parse(VALID_PLAN);

    expect(parsed).toEqual({ name: "Bono facial", priceEuro: 199.5, totalSessions: 5 });
  });

  it("refuses an empty name, a free price and a session count outside 1-100", () => {
    expect(createBonoPlanSchema.safeParse({ ...VALID_PLAN, name: "  " }).success).toBe(false);
    expect(createBonoPlanSchema.safeParse({ ...VALID_PLAN, priceEuro: 0 }).success).toBe(false);
    expect(createBonoPlanSchema.safeParse({ ...VALID_PLAN, totalSessions: 101 }).success).toBe(false);
    expect(createBonoPlanSchema.safeParse({ ...VALID_PLAN, totalSessions: 0.5 }).success).toBe(false);
  });
});

describe("updateBonoPlanSchema", () => {
  it("accepts a partial patch and refuses an empty one", () => {
    expect(updateBonoPlanSchema.safeParse({ totalSessions: 10 }).success).toBe(true);
    expect(updateBonoPlanSchema.safeParse({}).success).toBe(false);
  });
});

describe("bonusPointsSchema", () => {
  it("accepts multiples of ten, the ledger's whole euros of progress", () => {
    expect(bonusPointsSchema.safeParse(10).success).toBe(true);
    expect(bonusPointsSchema.safeParse(250).success).toBe(true);
  });

  it("refuses what the ledger could not represent honestly", () => {
    expect(bonusPointsSchema.safeParse(0).success).toBe(false);
    expect(bonusPointsSchema.safeParse(25).success).toBe(false);
    expect(bonusPointsSchema.safeParse(11.5).success).toBe(false);
  });
});

describe("startAtSessionSchema", () => {
  it("bounds the mid-way start like the plan bounds its sessions", () => {
    expect(startAtSessionSchema.safeParse(1).success).toBe(true);
    expect(startAtSessionSchema.safeParse(100).success).toBe(true);
    expect(startAtSessionSchema.safeParse(0).success).toBe(false);
    expect(startAtSessionSchema.safeParse(101).success).toBe(false);
  });
});

describe("visitSchema BONO_SESSION", () => {
  it("accepts a plan, a member bono, or the legacy free-text package", () => {
    expect(visitSchema.safeParse({ kind: "BONO_SESSION", planId: "plan-1", idempotencyKey: KEY }).success).toBe(true);
    expect(
      visitSchema.safeParse({ kind: "BONO_SESSION", memberBonoId: "b-1", idempotencyKey: KEY }).success
    ).toBe(true);
    expect(
      visitSchema.safeParse({
        kind: "BONO_SESSION",
        package: { priceEuro: 199, sessions: 5 },
        idempotencyKey: KEY
      }).success
    ).toBe(true);
  });

  it("refuses a session that names no bono at all", () => {
    const parsed = visitSchema.safeParse({ kind: "BONO_SESSION", idempotencyKey: KEY });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain("Indica el bono");
    }
  });

  it("carries a mid-way start and bonus points on both visit kinds", () => {
    expect(
      visitSchema.safeParse({
        kind: "BONO_SESSION",
        planId: "plan-1",
        startAtSession: 3,
        bonusPoints: 20,
        idempotencyKey: KEY
      }).success
    ).toBe(true);
    expect(
      visitSchema.safeParse({
        kind: "PAYMENT",
        lines: [{ amountEuro: 50 }],
        bonusPoints: 30,
        idempotencyKey: KEY
      }).success
    ).toBe(true);
  });
});
