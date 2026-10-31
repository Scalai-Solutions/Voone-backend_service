import { describe, expect, it } from "vitest";

import { ADMIN, MANAGER, OWNER, OWNER_B, ticketBody, useRouteHarness } from "./harness";

const h = useRouteHarness("test-cr-route");
const { db, call, make, adminSet, adminSay } = h;
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

describe("owner routes: create", () => {
  it("creates a ticket for the clinic named in the path, with the actor from headers", async () => {
    const res = await call(
      "POST",
      "/clinics/test-cr-route-a/change-requests",
      MANAGER,
      ticketBody({
        type: "SERVICE_EDIT",
        title: "Cambiar precio",
        targetRef: { treatmentId: "t-1" },
        proposed: { priceEuro: 55 }
      })
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: "SERVICE_EDIT",
      status: "OPEN",
      title: "Cambiar precio",
      targetRef: { treatmentId: "t-1" },
      proposed: { priceEuro: 55 },
      createdByEmail: "manager@a.test",
      createdByRole: "MANAGER"
    });
    expect(res.body).not.toHaveProperty("clinicId");
    expect(res.body).not.toHaveProperty("emailSentAt");
    const row = await db.changeRequest.findUniqueOrThrow({ where: { id: res.body.id } });

    expect(row.clinicId).toBe(a.id);
  });

  it("refuses a body that tries to set the clinic, status or creator", async () => {
    for (const extra of [
      { clinicId: b.id },
      { status: "RESOLVED" },
      { createdByEmail: "x@y.z" },
      { programId: "p" }
    ]) {
      const res = await call(
        "POST",
        "/clinics/test-cr-route-a/change-requests",
        OWNER,
        ticketBody(extra)
      );

      expect(res.status).toBe(422);
    }
    expect(await db.changeRequest.count({ where: { clinicId: { in: [a.id, b.id] } } })).toBe(0);
  });

  it.each([
    ["an employee", { actor: "e@a.test", role: "staff" }],
    ["an employee spelled otherwise", { actor: "e@a.test", role: "EMPLOYEE" }],
    ["a Voone admin", ADMIN],
    ["no role", { actor: "x@a.test" }],
    ["an empty role", { actor: "x@a.test", role: "  " }],
    ["no actor", { role: "owner" }],
    ["a blank actor", { actor: "   ", role: "owner" }],
    ["nothing", {}]
  ])("403s %s", async (_name, who) => {
    const res = await call("POST", "/clinics/test-cr-route-a/change-requests", who, ticketBody());

    expect(res.status).toBe(403);
    expect(await db.changeRequest.count({ where: { clinicId: a.id } })).toBe(0);
  });

  it("accepts the role in any case", async () => {
    for (const role of ["OWNER", "Manager", " owner "]) {
      const res = await call(
        "POST",
        "/clinics/test-cr-route-a/change-requests",
        { actor: "o@a.test", role },
        ticketBody()
      );

      expect(res.status).toBe(201);
    }
  });

  it("422s a bad body with the first problem in Spanish", async () => {
    const res = await call(
      "POST",
      "/clinics/test-cr-route-a/change-requests",
      OWNER,
      ticketBody({ reason: "a" })
    );

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/motivo/i);
    expect(res.body.code).toBe("CHANGE_REQUEST_INVALID");

    const typed = await call(
      "POST",
      "/clinics/test-cr-route-a/change-requests",
      OWNER,
      ticketBody({ type: "SERVICE_ADD", proposed: { name: "x" } })
    );

    expect(typed.status).toBe(422);
  });

  it("404s an unknown clinic slug", async () => {
    expect(
      (await call("POST", "/clinics/nope-nope/change-requests", OWNER, ticketBody())).status
    ).toBe(404);
    expect((await call("GET", "/clinics/nope-nope/change-requests", OWNER)).status).toBe(404);
  });

  it("answers 409 with a Spanish message at the open-ticket limit", async () => {
    for (let i = 0; i < 20; i++) await make();
    const res = await call("POST", "/clinics/test-cr-route-a/change-requests", OWNER, ticketBody());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHANGE_REQUEST_LIMIT_REACHED");
    expect(res.body.message).toMatch(/solicitudes abiertas/);
  });
});

describe("owner routes: read", () => {
  it("lists only the clinic's own tickets, newest first, with a cursor", async () => {
    const first = await make();
    const second = await make();

    await make("test-cr-route-b", OWNER_B);
    const page1 = await call("GET", "/clinics/test-cr-route-a/change-requests?limit=1", OWNER);

    expect(page1.status).toBe(200);
    expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([second.id]);
    expect(typeof page1.body.nextCursor).toBe("string");
    const page2 = await call(
      "GET",
      `/clinics/test-cr-route-a/change-requests?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      OWNER
    );

    expect(page2.body.items.map((i: { id: string }) => i.id)).toEqual([first.id]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("filters by status and rejects a bad filter, limit or cursor", async () => {
    const t = await make();

    await adminSet(t.id, "IN_PROGRESS");
    await make();
    const res = await call(
      "GET",
      "/clinics/test-cr-route-a/change-requests?status=IN_PROGRESS",
      OWNER
    );

    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([t.id]);
    for (const q of ["status=NOPE", "limit=0", "limit=500", "cursor=%25%25"]) {
      expect(
        (await call("GET", `/clinics/test-cr-route-a/change-requests?${q}`, OWNER)).status
      ).toBe(422);
    }
  });

  it("returns the detail with the thread", async () => {
    const t = await make();

    await adminSay(t.id, "Hola");
    const res = await call("GET", `/clinics/test-cr-route-a/change-requests/${t.id}`, OWNER);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({ authorKind: "VOONE", body: "Hola" });
  });

  it("404s another clinic's ticket on read, reply and reopen, and changes nothing", async () => {
    const theirs = await make("test-cr-route-b", OWNER_B);
    const paths: Array<[string, string, unknown?]> = [
      ["GET", `/clinics/test-cr-route-a/change-requests/${theirs.id}`],
      ["POST", `/clinics/test-cr-route-a/change-requests/${theirs.id}/messages`, { body: "hola" }],
      ["POST", `/clinics/test-cr-route-a/change-requests/${theirs.id}/reopen`, {}]
    ];

    for (const [method, path, body] of paths) {
      expect((await call(method, path, OWNER, body)).status).toBe(404);
    }
    expect(await db.changeRequestMessage.count({ where: { requestId: theirs.id } })).toBe(0);
  });

  it("applies the role gate to reads and replies too", async () => {
    const t = await make();

    for (const [method, path, body] of [
      ["GET", "/clinics/test-cr-route-a/change-requests", undefined],
      ["GET", `/clinics/test-cr-route-a/change-requests/${t.id}`, undefined],
      ["POST", `/clinics/test-cr-route-a/change-requests/${t.id}/messages`, { body: "x" }],
      ["POST", `/clinics/test-cr-route-a/change-requests/${t.id}/reopen`, {}]
    ] as Array<[string, string, unknown]>) {
      expect((await call(method, path, { actor: "e@a.test", role: "staff" }, body)).status).toBe(
        403
      );
    }
  });
});

describe("owner routes: reads without x-actor", () => {
  it("lets an owner read with the role alone, but not write", async () => {
    const t = await make();
    const roleOnly = { role: "owner" };

    expect((await call("GET", "/clinics/test-cr-route-a/change-requests", roleOnly)).status).toBe(
      200
    );
    expect(
      (await call("GET", `/clinics/test-cr-route-a/change-requests/${t.id}`, roleOnly)).status
    ).toBe(200);
    expect(
      (
        await call("POST", `/clinics/test-cr-route-a/change-requests/${t.id}/messages`, roleOnly, {
          body: "hola"
        })
      ).status
    ).toBe(403);
  });
});

describe("owner routes: reply and reopen", () => {
  it("replies with the actor's email and reopens a closed ticket inside the window", async () => {
    const t = await make();

    await adminSet(t.id, "RESOLVED", "Hecho");
    const res = await call(
      "POST",
      `/clinics/test-cr-route-a/change-requests/${t.id}/messages`,
      MANAGER,
      { body: "Aún no funciona" }
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("OPEN");
    expect(res.body.messages.at(-1)).toMatchObject({
      authorKind: "CLINIC",
      authorEmail: "manager@a.test",
      body: "Aún no funciona"
    });
  });

  it("409s a reply and a reopen once the window has passed", async () => {
    const t = await make();

    await adminSet(t.id, "REJECTED", "No");
    await db.changeRequest.update({
      where: { id: t.id },
      data: { resolvedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }
    });

    const reply = await call(
      "POST",
      `/clinics/test-cr-route-a/change-requests/${t.id}/messages`,
      OWNER,
      { body: "hola" }
    );
    const reopen = await call(
      "POST",
      `/clinics/test-cr-route-a/change-requests/${t.id}/reopen`,
      OWNER,
      {}
    );

    expect(reply.status).toBe(409);
    expect(reply.body.message).toMatch(/14 días/);
    expect(reopen.status).toBe(409);
  });

  it("reopens with an optional message and 409s reopening an open ticket", async () => {
    const t = await make();

    expect(
      (await call("POST", `/clinics/test-cr-route-a/change-requests/${t.id}/reopen`, OWNER, {}))
        .status
    ).toBe(409);
    await adminSet(t.id, "RESOLVED", "Hecho");
    const res = await call(
      "POST",
      `/clinics/test-cr-route-a/change-requests/${t.id}/reopen`,
      OWNER,
      { message: "Sigue igual" }
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OPEN");
    expect(res.body.messages).toHaveLength(1);
  });

  it("422s an empty or oversized reply and an unknown key", async () => {
    const t = await make();
    const path = `/clinics/test-cr-route-a/change-requests/${t.id}/messages`;

    for (const body of [
      { body: "  " },
      { body: "x".repeat(2001) },
      { body: "ok", authorKind: "VOONE" },
      {}
    ]) {
      expect((await call("POST", path, OWNER, body)).status).toBe(422);
    }
  });

  it("gives the owner no way to change a status", async () => {
    const t = await make();

    for (const path of [
      `/clinics/test-cr-route-a/change-requests/${t.id}/status`,
      `/clinics/test-cr-route-a/change-requests/${t.id}`
    ]) {
      expect(
        (await call("PATCH", path, OWNER, { status: "RESOLVED", resolutionNote: "x" })).status
      ).toBe(404);
    }
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OPEN");
  });
});
