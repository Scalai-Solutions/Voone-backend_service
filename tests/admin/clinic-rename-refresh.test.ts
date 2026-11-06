import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { call, createClinicWithLogo, db, removeClinic } from "./admin-clinics.harness";

const refresh = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("../../src/modules/wallet-refresh/clinic-card-refresh", () => ({
  refreshClinicCards: refresh
}));

const created: string[] = [];

const liveClinic = async () => {
  const clinic = await createClinicWithLogo("https://clinica.example/logo.png", {
    isActive: true
  });

  created.push(clinic.id);

  return clinic;
};

beforeEach(() => refresh.mockClear());

afterEach(async () => {
  while (created.length > 0) await removeClinic(created.pop() as string);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("renaming a clinic reaches the cards members already hold", () => {
  it("refreshes the clinic's cards when the name changes", async () => {
    const clinic = await liveClinic();

    const reply = await call("PATCH", `/admin/clinics/${clinic.id}`, { name: "Centro Renombrado" });

    expect(reply.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(clinic.id);
  });

  it("does nothing for a save that keeps the same name or changes something else", async () => {
    const clinic = await liveClinic();
    const current = await db.clinic.findUniqueOrThrow({ where: { id: clinic.id } });

    await call("PATCH", `/admin/clinics/${clinic.id}`, { name: current.name });
    await call("PATCH", `/admin/clinics/${clinic.id}`, { addressLine: "Calle Nueva 2" });

    expect(refresh).not.toHaveBeenCalled();
  });
});
