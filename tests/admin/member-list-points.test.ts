import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../../src/infrastructure/database/prisma-client";
import { call, createClinicWithLogo, db, removeClinic } from "./admin-clinics.harness";

const clinics: string[] = [];

const memberAt = async (clinicId: string, pointsBalance: number): Promise<string> =>
  (
    await db.member.create({
      data: {
        clinicId,
        name: `Miembro ${pointsBalance}`,
        pointsBalance,
        consentMarketing: false,
        consentSource: "test"
      }
    })
  ).id;

afterEach(async () => {
  while (clinics.length > 0) {
    const clinicId = clinics.pop() as string;

    await db.member.deleteMany({ where: { clinicId } });
    await removeClinic(clinicId);
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GET /admin/members shows the unit a member sees", () => {
  it("shows points (ten per euro) at a programme centre and the ledger figure elsewhere", async () => {
    // The harness gives a clinic a live programme; the other one has it taken away.
    const programme = await createClinicWithLogo("https://clinica.example/logo.png");
    const plain = await createClinicWithLogo("https://clinica.example/logo.png");

    clinics.push(programme.id, plain.id);
    await db.onboardingProgram.deleteMany({ where: { clinicId: plain.id } });

    const inProgramme = await memberAt(programme.id, 120);
    const inProgrammeToo = await memberAt(programme.id, 5);
    const inPlain = await memberAt(plain.id, 120);

    const reply = await call("GET", "/admin/members");

    expect(reply.status).toBe(200);

    const pointsOf = (id: string) =>
      reply.body.find((member: { id: string }) => member.id === id)?.points;

    expect(pointsOf(inProgramme)).toBe(1200);
    expect(pointsOf(inProgrammeToo)).toBe(50);
    expect(pointsOf(inPlain)).toBe(120);
  });

  it("asks once for the programme centres of the whole list, not once per member", async () => {
    const first = await createClinicWithLogo("https://clinica.example/logo.png");
    const second = await createClinicWithLogo("https://clinica.example/logo.png");

    clinics.push(first.id, second.id);
    for (const clinicId of [first.id, first.id, first.id, second.id, second.id]) {
      await memberAt(clinicId, 1);
    }

    const asked = [
      vi.spyOn(prisma.onboardingProgram, "count"),
      vi.spyOn(prisma.onboardingProgram, "findMany"),
      vi.spyOn(prisma.onboardingProgram, "findFirst")
    ];

    try {
      const reply = await call("GET", "/admin/members");

      expect(reply.status).toBe(200);
      expect(asked.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(1);
    } finally {
      for (const spy of asked) spy.mockRestore();
    }
  });
});
