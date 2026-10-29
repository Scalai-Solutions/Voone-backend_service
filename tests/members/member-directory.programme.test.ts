import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { MemberDirectoryService } from "../../src/modules/members/member-directory.service";

/**
 * Founders' E2E items 48/49: at a centre with a live programme, a €60 payment shows 600 points
 * and €60 spent, not 60 points and €0.
 */
const row = {
  id: "m-1",
  name: "Clienta",
  code: "K7M2Q",
  phone: "+34612345678",
  email: null,
  birthDate: null,
  birthYear: null,
  sex: null,
  clinicId: "c-1",
  pointsBalance: 60,
  tier: "Bronce",
  erasedAt: null,
  clinic: { template: { id: "t", programName: "Club", tierRewards: [] } },
  walletObjects: [],
  pointsLedger: [
    {
      id: "l1",
      points: 60,
      kind: "EARN",
      reason: "Visita de pago",
      createdAt: new Date("2026-10-19")
    }
  ]
};

const serviceFor = (
  programme: boolean,
  catalogue: Array<{ id: string; name: string; priceCents: number; categoryId: null }> = [],
  credits: Array<{ memberId: string; reason: string; createdAt: Date }> = [],
  tier: string | null = row.tier
) => {
  // The member as the directory's own query returns her, including whether the clinic's
  // programme is live.
  const current = {
    ...row,
    tier,
    clinic: {
      template: {
        id: "t",
        programName: "Club",
        tierRewards: [{ name: "Silver", minLifetimePoints: 0 }]
      },
      onboardingPrograms: programme ? [{ id: "p-1" }] : []
    }
  };
  const prisma = {
    member: { findMany: async () => [current], findUnique: async () => current },
    // Spending stats read treatments through listTreatments, which asks the catalogue first.
    catalogItem: { count: async () => catalogue.length, findMany: async () => catalogue },
    clinicTreatment: { findMany: async () => [] },
    pointsTransaction: { findMany: async () => credits },
    onboardingProgram: { findFirst: async () => (programme ? { id: "p-1" } : null) },
    paidVisit: {
      groupBy: async () => [
        {
          memberId: "m-1",
          _sum: { amountCents: 6000 },
          _max: { occurredAt: new Date("2026-10-19T10:00:00Z") }
        }
      ]
    }
  } as unknown as PrismaClient;

  return new MemberDirectoryService(prisma, () => new Set());
};

describe("member directory at a programme centre", () => {
  it("shows ten points per euro and the euros the visits paid", async () => {
    const [member] = await serviceFor(true).list({ clinicId: "c-1", limit: 10, offset: 0 });

    expect(member.points).toBe(600);
    expect(member.moneySpent).toBe(60);
    expect(member.lastVisitedAt).toBe("2026-10-19T10:00:00.000Z");
    expect(member.history[0].points).toBe(600);
  });

  it("leaves a centre without a programme exactly as it was", async () => {
    const [member] = await serviceFor(false).list({ clinicId: "c-1", limit: 10, offset: 0 });

    expect(member.points).toBe(60);
    expect(member.moneySpent).toBe(0);
  });

  it("prices a visit from the catalogue the scan screen reads", async () => {
    const [member] = await serviceFor(
      false,
      [{ id: "i-1", name: "Hydrafacial", priceCents: 12000, categoryId: null }],
      [{ memberId: "m-1", reason: "Hydrafacial", createdAt: new Date("2026-10-19") }]
    ).list({ clinicId: "c-1", limit: 10, offset: 0 });

    expect(member.moneySpent).toBe(120);
  });

  it("labels a member with no tier by the programme's first rung at a programme centre", async () => {
    const [member] = await serviceFor(true, [], [], null).list({
      clinicId: "c-1",
      limit: 10,
      offset: 0
    });

    expect(member.tier).toBe("Bronce");
  });

  it("keeps the template's lowest tier for a tierless member at a centre without a programme", async () => {
    const [member] = await serviceFor(false, [], [], null).list({
      clinicId: "c-1",
      limit: 10,
      offset: 0
    });

    expect(member.tier).toBe("Silver");
  });
});
