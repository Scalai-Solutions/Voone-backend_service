import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { displayPoints, isProgrammeCentre } from "../../src/modules/onboarding/runtime/points-unit";

const prismaWith = (activeProgrammes: number) =>
  ({
    onboardingProgram: {
      count: async ({ where }: { where: { clinicId: string; status: string } }) =>
        where.clinicId === "clinic-1" && where.status === "ACTIVO" ? activeProgrammes : 0
    }
  }) as unknown as PrismaClient;

describe("isProgrammeCentre", () => {
  it("is true for a clinic with a published (ACTIVO) programme", async () => {
    expect(await isProgrammeCentre(prismaWith(1), "clinic-1")).toBe(true);
  });

  it("is false for a clinic without one", async () => {
    expect(await isProgrammeCentre(prismaWith(0), "clinic-1")).toBe(false);
  });
});

describe("displayPoints", () => {
  it("shows a programme centre's euro progress as points, ten per euro", async () => {
    expect(await displayPoints(prismaWith(1), "clinic-1", 120)).toBe(1200);
  });

  it("leaves every other centre's balance as the ledger holds it", async () => {
    expect(await displayPoints(prismaWith(0), "clinic-1", 120)).toBe(120);
  });
});
