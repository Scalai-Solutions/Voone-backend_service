import { describe, expect, it } from "vitest";

import { ADMIN, MANAGER, OWNER, useRouteHarness } from "./harness";

const h = useRouteHarness("test-cr-draftroute");
const { db, call, make } = h;

const activeProgramme = (clinicId: string, version = 1) =>
  db.onboardingProgram.create({
    data: {
      clinicId,
      version,
      status: "ACTIVO",
      engineVersion: "t",
      configVersion: "t",
      answers: {},
      catalogSnapshot: [],
      output: {}
    }
  });

describe("POST /admin/change-requests/:id/draft", () => {
  it("403s non-admins; the owner has no such route", async () => {
    const t = await make(h.slugA, OWNER, { type: "REWARD" });

    for (const who of [OWNER, MANAGER, {}, { role: "voone_admin" }]) {
      expect((await call("POST", `/admin/change-requests/${t.id}/draft`, who, {})).status).toBe(
        403
      );
    }
    expect(
      (await call("POST", `/clinics/${h.slugA}/change-requests/${t.id}/draft`, OWNER, {})).status
    ).toBe(404);
  });

  it("answers {request, programId} and 409s a type that has no draft", async () => {
    await activeProgramme(h.a.id);
    const reward = await make(h.slugA, OWNER, { type: "REWARD" });
    const res = await call("POST", `/admin/change-requests/${reward.id}/draft`, ADMIN, {});

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ id: reward.id, status: "IN_PROGRESS" });
    expect(res.body.programId).toBe(res.body.request.programId);

    const other = await make(h.slugA, OWNER, { type: "OTHER" });
    const refused = await call("POST", `/admin/change-requests/${other.id}/draft`, ADMIN, {});

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CHANGE_REQUEST_NOT_APPLICABLE");
    expect((await call("POST", "/admin/change-requests/nope/draft", ADMIN, {})).status).toBe(404);
    expect(
      (await call("POST", `/admin/change-requests/${reward.id}/draft`, ADMIN, { x: 1 })).status
    ).toBe(422);
  });
});

describe("POST /admin/clinics/:clinicId/onboarding/programs/:programId/resolve-tickets", () => {
  const path = (clinicId: string, programId: string) =>
    `/admin/clinics/${clinicId}/onboarding/programs/${programId}/resolve-tickets`;

  it("403s non-admins", async () => {
    const programme = await activeProgramme(h.a.id);

    for (const who of [OWNER, MANAGER, {}, { role: "voone_admin" }]) {
      expect((await call("POST", path(h.a.id, programme.id), who, { note: "x" })).status).toBe(403);
    }
  });

  it("resolves the linked tickets and answers {resolved}", async () => {
    const programme = await activeProgramme(h.a.id);
    const t = await make(h.slugA, OWNER, { type: "REWARD" });

    await db.changeRequest.update({ where: { id: t.id }, data: { programId: programme.id } });
    const res = await call("POST", path(h.a.id, programme.id), ADMIN, { note: "Published" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: [t.id] });
    expect((await db.changeRequest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
      "RESOLVED"
    );
  });

  it("422s a missing or blank note and an unknown key; 404s another clinic's programme", async () => {
    const programme = await activeProgramme(h.a.id);

    for (const body of [{}, { note: "  " }, { note: "x", extra: 1 }]) {
      expect((await call("POST", path(h.a.id, programme.id), ADMIN, body)).status).toBe(422);
    }
    expect((await call("POST", path(h.b.id, programme.id), ADMIN, { note: "x" })).status).toBe(404);
  });
});
