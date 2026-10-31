import { describe, expect, it } from "vitest";

import { ADMIN, MANAGER, OWNER, useRouteHarness } from "./harness";

const h = useRouteHarness("test-cr-applyroute");
const { db, call, make } = h;

const addTicket = () =>
  make(h.slugA, OWNER, {
    type: "SERVICE_ADD",
    proposed: { name: "Ruta", priceEuro: 12 }
  });

describe("POST /admin/change-requests/:id/apply", () => {
  it("403s anyone but a Voone admin and the owner has no such route", async () => {
    const t = await addTicket();

    for (const who of [OWNER, MANAGER, {}, { role: "voone_admin" }]) {
      expect((await call("POST", `/admin/change-requests/${t.id}/apply`, who, {})).status).toBe(
        403
      );
    }
    expect(
      (await call("POST", `/clinics/${h.slugA}/change-requests/${t.id}/apply`, OWNER, {})).status
    ).toBe(404);
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OPEN");
  });

  it("applies and answers {request, applied, warnings}", async () => {
    await db.clinicTreatment.deleteMany({ where: { clinicId: h.a.id } });
    const t = await addTicket();
    const res = await call("POST", `/admin/change-requests/${t.id}/apply`, ADMIN, {
      note: "Added for you"
    });

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      id: t.id,
      status: "RESOLVED",
      resolutionNote: "Added for you",
      resolvedByEmail: "admin@voone.test"
    });
    expect(res.body.applied).toMatchObject({ action: "created" });
    expect(res.body.warnings).toEqual([]);
    expect(await db.clinicTreatment.count({ where: { clinicId: h.a.id, name: "Ruta" } })).toBe(1);

    const again = await call("POST", `/admin/change-requests/${t.id}/apply`, ADMIN, {});

    expect(again.status).toBe(409);
    expect(again.body.code).toBe("CHANGE_REQUEST_ALREADY_CLOSED");
  });

  it("422s a bad body and 404s an unknown ticket", async () => {
    const t = await addTicket();

    expect(
      (await call("POST", `/admin/change-requests/${t.id}/apply`, ADMIN, { status: "OPEN" })).status
    ).toBe(422);
    expect(
      (
        await call("POST", `/admin/change-requests/${t.id}/apply`, ADMIN, {
          note: "x".repeat(2001)
        })
      ).status
    ).toBe(422);
    expect((await call("POST", "/admin/change-requests/nope/apply", ADMIN, {})).status).toBe(404);
  });

  it("exposes catalogueImpact on the detail", async () => {
    const t = await addTicket();
    const res = await call("GET", `/admin/change-requests/${t.id}`, ADMIN);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("catalogueImpact", null);
  });
});
