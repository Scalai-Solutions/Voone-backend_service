import { describe, expect, it } from "vitest";

import { ADMIN, MANAGER, OWNER, ticketBody, useRouteHarness } from "./harness";

const h = useRouteHarness("test-cr-autoroute", { autoApprove: true });
const { db, call } = h;

const post = (who = OWNER, over: Record<string, unknown> = {}) =>
  call("POST", `/clinics/${h.slugA}/change-requests`, who, ticketBody(over));

describe("POST /clinics/:slug/change-requests for a treatment or a bono", () => {
  it("applies it at once and answers the resolved, auto-approved ticket", async () => {
    const res = await post(OWNER, {
      type: "SERVICE_ADD",
      proposed: { name: "Ruta", priceEuro: 12 }
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "RESOLVED",
      autoApproved: true,
      reopenableUntil: null,
      warnings: []
    });
    expect(res.body.resolutionNote).toMatch(/^Aprobada y aplicada automáticamente/);
    expect(await db.clinicTreatment.count({ where: { clinicId: h.a.id, name: "Ruta" } })).toBe(1);
  });

  it("lets a manager do the same, and a bono too", async () => {
    const bono = await post(MANAGER, {
      type: "BONO",
      proposed: { action: "add", name: "Bono ruta", priceEuro: 100, totalSessions: 4 }
    });

    expect(bono.status).toBe(201);
    expect(bono.body).toMatchObject({ status: "RESOLVED", autoApproved: true });
    expect(await db.bonoPlan.count({ where: { clinicId: h.a.id, name: "Bono ruta" } })).toBe(1);
  });

  it("answers the catalogue's own refusal and stores nothing", async () => {
    const res = await post(OWNER, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: "no-existe" },
      proposed: { priceEuro: 10 }
    });

    expect(res.status).toBe(404);
    expect(await db.changeRequest.count({ where: { clinicId: h.a.id } })).toBe(0);
  });

  it("is listed for the centre as resolved and for Voone as automatic", async () => {
    await post(OWNER, { type: "SERVICE_ADD", proposed: { name: "Ruta", priceEuro: 12 } });

    const own = await call("GET", `/clinics/${h.slugA}/change-requests`, OWNER);
    const admin = await call("GET", `/admin/clinics/${h.a.id}/change-requests`, ADMIN);

    expect(own.body.items[0]).toMatchObject({ status: "RESOLVED", autoApproved: true });
    expect(admin.body.items[0]).toMatchObject({ status: "RESOLVED", autoApproved: true });
  });

  it("leaves a reward ticket open for Voone", async () => {
    const res = await post(OWNER, { type: "REWARD" });

    expect(res.body).toMatchObject({ status: "OPEN", autoApproved: false });
  });
});
