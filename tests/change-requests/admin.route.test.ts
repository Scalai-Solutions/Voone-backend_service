import { describe, expect, it } from "vitest";

import { ADMIN, MANAGER, OWNER, OWNER_B, useRouteHarness } from "./harness";

const h = useRouteHarness("test-cr-admin");
const { db, call, make, adminSay } = h;
const a = {
  get id() {
    return h.a.id;
  }
};
const b = {
  get id() {
    return h.b.id;
  }
};

describe("admin routes", () => {
  it("403s every admin route for a non-admin or a caller with no role", async () => {
    const t = await make();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/admin/change-requests"],
      ["GET", `/admin/clinics/${a.id}/change-requests`],
      ["GET", `/admin/change-requests/${t.id}`],
      ["PATCH", `/admin/change-requests/${t.id}/status`, { status: "IN_PROGRESS" }],
      ["POST", `/admin/change-requests/${t.id}/messages`, { body: "x" }]
    ];

    for (const who of [OWNER, MANAGER, {}, { actor: "a@voone.test" }]) {
      for (const [method, path, body] of routes) {
        expect((await call(method, path, who, body)).status).toBe(403);
      }
    }
  });

  it("reads need only the role (the app sends x-actor on writes only); writes need the email too", async () => {
    const t = await make();
    const adminNoActor = { role: "voone_admin" };

    for (const path of [
      "/admin/change-requests",
      `/admin/clinics/${a.id}/change-requests`,
      `/admin/change-requests/${t.id}`
    ]) {
      expect((await call("GET", path, adminNoActor)).status).toBe(200);
    }
    expect(
      (
        await call("PATCH", `/admin/change-requests/${t.id}/status`, adminNoActor, {
          status: "IN_PROGRESS"
        })
      ).status
    ).toBe(403);
    expect(
      (await call("POST", `/admin/change-requests/${t.id}/messages`, adminNoActor, { body: "x" }))
        .status
    ).toBe(403);
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OPEN");
  });

  it("lists across clinics with clinic details, last message time and filters", async () => {
    const x = await make("test-cr-admin-a", OWNER, { type: "BONO", title: "Bono nuevo" });
    const y = await make("test-cr-admin-b", OWNER_B, { title: "Otra cosa" });

    await adminSay(x.id, "Hola");
    const all = await call("GET", "/admin/change-requests?limit=50", ADMIN);
    const mine = all.body.items.filter((i: { clinicId: string }) =>
      [a.id, b.id].includes(i.clinicId)
    );

    expect(all.status).toBe(200);
    expect(mine).toHaveLength(2);
    const row = mine.find((i: { id: string }) => i.id === x.id);

    expect(row.clinic).toEqual({ id: a.id, name: "Clinica Ruta Alfa", slug: "test-cr-admin-a" });
    expect(row.lastMessageAt).toEqual(expect.any(String));
    expect(row.messageCount).toBe(1);
    expect(mine.find((i: { id: string }) => i.id === y.id).lastMessageAt).toBeNull();

    const ids = async (qs: string) =>
      (await call("GET", `/admin/change-requests?${qs}`, ADMIN)).body.items.map(
        (i: { id: string }) => i.id
      );

    expect(await ids(`clinicId=${b.id}`)).toEqual([y.id]);
    expect(await ids(`clinicId=${a.id}&type=BONO`)).toEqual([x.id]);
    expect(await ids(`clinicId=${a.id}&type=REWARD`)).toEqual([]);
    expect(await ids(`clinicId=${a.id}&status=RESOLVED`)).toEqual([]);
    expect(await ids(`clinicId=${a.id}&q=bono`)).toEqual([x.id]);
    expect(await ids("q=ruta%20beta&limit=50")).toContain(y.id);
    expect((await call("GET", "/admin/change-requests?status=NOPE", ADMIN)).status).toBe(422);
  });

  it("lists one clinic's tickets, and 404s an unknown clinic", async () => {
    const x = await make();

    await make("test-cr-admin-b", OWNER_B);
    const res = await call("GET", `/admin/clinics/${a.id}/change-requests`, ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([x.id]);
    expect(
      (
        await call(
          "GET",
          "/admin/clinics/00000000-0000-0000-0000-000000000000/change-requests",
          ADMIN
        )
      ).status
    ).toBe(404);
  });

  it("shows the detail with the thread and the internal fields", async () => {
    const t = await make();

    await call("POST", `/clinics/test-cr-admin-a/change-requests/${t.id}/messages`, OWNER, {
      body: "Hola"
    });
    const res = await call("GET", `/admin/change-requests/${t.id}`, ADMIN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: t.id, createdByEmail: "owner@a.test", emailSentAt: null });
    expect(res.body.clinic.slug).toBe("test-cr-admin-a");
    expect(res.body.messages[0]).toMatchObject({
      authorKind: "CLINIC",
      authorEmail: "owner@a.test"
    });
    expect((await call("GET", "/admin/change-requests/nope", ADMIN)).status).toBe(404);
  });

  it("PATCH status: applies a legal transition and records who and when", async () => {
    const t = await make();
    const res = await call("PATCH", `/admin/change-requests/${t.id}/status`, ADMIN, {
      status: "RESOLVED",
      resolutionNote: "Aplicado"
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "RESOLVED",
      resolvedByEmail: "admin@voone.test",
      resolutionNote: "Aplicado"
    });
    expect(res.body.resolvedAt).toEqual(expect.any(String));
  });

  it("PATCH status: 409 on an illegal transition, 422 on a missing note or bad body", async () => {
    const t = await make();
    const path = `/admin/change-requests/${t.id}/status`;

    expect((await call("PATCH", path, ADMIN, { status: "OPEN" })).status).toBe(409);
    expect((await call("PATCH", path, ADMIN, { status: "RESOLVED" })).status).toBe(422);
    expect(
      (await call("PATCH", path, ADMIN, { status: "REJECTED", resolutionNote: " " })).status
    ).toBe(422);
    expect((await call("PATCH", path, ADMIN, { status: "DONE" })).status).toBe(422);
    expect((await call("PATCH", path, ADMIN, {})).status).toBe(422);
    await call("PATCH", path, ADMIN, { status: "REJECTED", resolutionNote: "No" });
    expect((await call("PATCH", path, ADMIN, { status: "IN_PROGRESS" })).status).toBe(409);
    expect((await call("PATCH", path, ADMIN, { status: "OPEN" })).status).toBe(200);
  });

  it("POST messages: authors a VOONE message with the admin's email", async () => {
    const t = await make();
    const res = await call("POST", `/admin/change-requests/${t.id}/messages`, ADMIN, {
      body: "Lo revisamos"
    });

    expect(res.status).toBe(201);
    expect(res.body.messages[0]).toMatchObject({
      authorKind: "VOONE",
      authorEmail: "admin@voone.test",
      body: "Lo revisamos"
    });
    expect(
      (await call("POST", "/admin/change-requests/nope/messages", ADMIN, { body: "x" })).status
    ).toBe(404);
  });

  it("403s the owner and manager from every transition and leaves the ticket alone", async () => {
    const t = await make();

    for (const who of [OWNER, MANAGER, {}, { actor: "x@a.test", role: "staff" }]) {
      const res = await call("PATCH", `/admin/change-requests/${t.id}/status`, who, {
        status: "RESOLVED",
        resolutionNote: "x"
      });

      expect(res.status).toBe(403);
    }
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OPEN");
  });

  it("treats % and _ in the text search literally", async () => {
    await make(h.slugA, OWNER, { title: "Descuento 100% real" });
    await make(h.slugA, OWNER, { title: "Descuento plano" });
    await make(h.slugA, OWNER, { title: "Nombre_con_guion" });
    await make(h.slugA, OWNER, { title: "Ruta C:\\temp" });

    const titles = async (q: string) =>
      (
        await call(
          "GET",
          `/admin/change-requests?clinicId=${a.id}&q=${encodeURIComponent(q)}`,
          ADMIN
        )
      ).body.items.map((i: { title: string }) => i.title);

    expect(await titles("%")).toEqual(["Descuento 100% real"]);
    expect(await titles("100%")).toEqual(["Descuento 100% real"]);
    expect(await titles("_")).toEqual(["Nombre_con_guion"]);
    expect(await titles("\\")).toEqual(["Ruta C:\\temp"]);
    expect(await titles("n_m")).toEqual([]);
    expect(await titles("DESCUENTO")).toHaveLength(2);
  });
});
