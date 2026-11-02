import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeRequestConflictError,
  ChangeRequestNotFoundError,
  ChangeRequestValidationError,
  ProgrammeNotFoundError
} from "../../src/common/errors/change-request.errors";
import type { ChangeRequestNotifier } from "../../src/modules/change-requests/notifier";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
import { PrismaProgramDrafts } from "../../src/modules/change-requests/program-drafts";
import { ChangeRequestService } from "../../src/modules/change-requests/service";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";

/**
 * Drafts from tickets and resolving the tickets linked to a published programme, on the
 * database with the real OnboardingService.cloneDraft. Slugs are unique to this file.
 */
const db = new PrismaClient();
const SLUGS = ["test-cr-draft-a", "test-cr-draft-b"];

let a: Clinic;
let b: Clinic;

const calls: Array<{ hook: string; args: unknown[] }> = [];
const recorder: ChangeRequestNotifier = {
  onCreated: async () => {},
  onOwnerReply: async () => {},
  onAdminReply: async () => {},
  onStatusChanged: async (request, previous, by) =>
    void calls.push({ hook: "onStatusChanged", args: [request, previous, by] })
};

const service = new ChangeRequestService(new PrismaChangeRequestRepository(db), {
  notifier: recorder,
  background: (task) => task,
  programs: new PrismaProgramDrafts(db, new OnboardingService(db, new PrismaCatalogRepository(db)))
});

const owner = { email: "dueno@draft.test", role: "OWNER" as const };
const admin = { email: "admin@voone.test" };

const wipe = async () => {
  await db.changeRequest.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.onboardingProgram.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
};

const program = (clinicId: string, version: number, status: "ACTIVO" | "BORRADOR" | "SUSTITUIDO") =>
  db.onboardingProgram.create({
    data: {
      clinicId,
      version,
      status,
      engineVersion: "t",
      configVersion: "t",
      answers: {},
      catalogSnapshot: [],
      output: { marker: `v${version}` }
    }
  });

beforeAll(async () => {
  const make = (slug: string) =>
    db.clinic.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug, addressLine: "Calle Prueba 5", pincode: "28001" }
    });

  a = await make(SLUGS[0]!);
  b = await make(SLUGS[1]!);
});

beforeEach(async () => {
  calls.length = 0;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

let counter = 0;

const file = async (clinic: Clinic, type = "REWARD") => {
  const ticket = await service.create(clinic.id, owner, {
    type,
    title: `Cambio ${++counter}`,
    reason: "Por favor."
  } as never);

  calls.length = 0;

  return ticket;
};

const row = (id: string) => db.changeRequest.findUniqueOrThrow({ where: { id } });

describe("draft from a ticket", () => {
  it("clones the ACTIVE programme, links it and moves OPEN to IN_PROGRESS", async () => {
    const active = await program(a.id, 1, "ACTIVO");
    const t = await file(a);
    const res = await service.adminDraft(t.id);
    const draft = await db.onboardingProgram.findFirstOrThrow({
      where: { clinicId: a.id, status: "BORRADOR" }
    });

    expect(draft).toMatchObject({ version: 2, output: { marker: "v1" } });
    expect(res.programId).toBe(draft.id);
    expect(res.request).toMatchObject({ status: "IN_PROGRESS", programId: draft.id });
    expect((await row(t.id)).programId).toBe(draft.id);
    expect(
      (await db.onboardingProgram.findUniqueOrThrow({ where: { id: active.id } })).status
    ).toBe("ACTIVO");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1)).toEqual(["OPEN", "VOONE"]);
  });

  it("reuses an existing draft for a second ticket, which links the same one", async () => {
    await program(a.id, 1, "ACTIVO");
    const first = await service.adminDraft((await file(a)).id);

    await service.adminSetStatus((await file(a, "LEVEL")).id, admin, { status: "IN_PROGRESS" });
    const second = await service.adminDraft((await file(a, "LEVEL")).id);

    expect(second.programId).toBe(first.programId);
    expect(await db.onboardingProgram.count({ where: { clinicId: a.id } })).toBe(2);
  });

  it("an IN_PROGRESS ticket stays IN_PROGRESS and fires no status hook", async () => {
    await program(a.id, 1, "ACTIVO");
    const t = await file(a, "LEVEL");

    await service.adminSetStatus(t.id, admin, { status: "IN_PROGRESS" });
    calls.length = 0;
    const res = await service.adminDraft(t.id);

    expect(res.request.status).toBe("IN_PROGRESS");
    expect(calls).toHaveLength(0);
  });

  it("uses an existing draft when there is no ACTIVE programme", async () => {
    const draft = await program(a.id, 3, "BORRADOR");
    const res = await service.adminDraft((await file(a)).id);

    expect(res.programId).toBe(draft.id);
  });

  it("409s in English when the clinic has no programme to work from, and changes nothing", async () => {
    await program(a.id, 1, "SUSTITUIDO");
    const t = await file(a);
    const error = (await service.adminDraft(t.id).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ChangeRequestConflictError);
    expect(error.message).toMatch(/no active programme/i);
    expect((await row(t.id)).status).toBe("OPEN");
    expect((await row(t.id)).programId).toBeNull();
  });

  it("is scoped to the ticket's clinic", async () => {
    await program(b.id, 1, "ACTIVO");
    const t = await file(a);

    await expect(service.adminDraft(t.id)).rejects.toBeInstanceOf(ChangeRequestConflictError);
    expect(await db.onboardingProgram.count({ where: { clinicId: b.id } })).toBe(1);
  });

  it("refuses other types, closed tickets and unknown ids", async () => {
    await program(a.id, 1, "ACTIVO");

    for (const type of ["SERVICE_EDIT", "SERVICE_ADD", "SERVICE_REMOVE", "BONO", "OTHER"]) {
      const t = await service.create(a.id, owner, {
        type,
        title: "x",
        reason: "xxx",
        ...(type === "SERVICE_EDIT" || type === "SERVICE_REMOVE"
          ? { targetRef: { treatmentId: "t" } }
          : {}),
        ...(type === "SERVICE_EDIT" ? { proposed: { name: "n" } } : {}),
        ...(type === "SERVICE_ADD" ? { proposed: { name: "n", priceEuro: 1 } } : {})
      } as never);

      await expect(service.adminDraft(t.id)).rejects.toBeInstanceOf(ChangeRequestConflictError);
    }

    const closed = await file(a);

    await service.adminSetStatus(closed.id, admin, { status: "REJECTED", resolutionNote: "No" });
    await expect(service.adminDraft(closed.id)).rejects.toBeInstanceOf(ChangeRequestConflictError);
    await expect(service.adminDraft("nope")).rejects.toBeInstanceOf(ChangeRequestNotFoundError);
    expect(await db.onboardingProgram.count({ where: { clinicId: a.id } })).toBe(1);
  });
});

describe("resolve the tickets linked to a programme", () => {
  const linked = async (clinic: Clinic, programId: string, status?: "IN_PROGRESS" | "RESOLVED") => {
    const t = await file(clinic);

    await db.changeRequest.update({ where: { id: t.id }, data: { programId } });
    if (status === "IN_PROGRESS") await service.adminSetStatus(t.id, admin, { status });
    if (status === "RESOLVED") {
      await service.adminSetStatus(t.id, admin, { status, resolutionNote: "Antes" });
    }
    calls.length = 0;

    return t.id;
  };

  it("resolves every non-closed linked ticket of an ACTIVE programme and tells the notifier", async () => {
    const published = await program(a.id, 1, "ACTIVO");
    const elsewhere = await program(a.id, 0, "SUSTITUIDO");
    const open = await linked(a, published.id);
    const progress = await linked(a, published.id, "IN_PROGRESS");
    const done = await linked(a, published.id, "RESOLVED");
    const unrelated = await linked(a, elsewhere.id);
    const bare = (await file(a)).id;

    const res = await service.adminResolveLinked(a.id, published.id, admin, "  Published v1  ");

    expect([...res.resolved].sort()).toEqual([open, progress].sort());
    for (const id of [open, progress]) {
      expect(await row(id)).toMatchObject({
        status: "RESOLVED",
        resolvedByEmail: "admin@voone.test",
        resolutionNote: "Published v1"
      });
    }
    expect((await row(done)).resolutionNote).toBe("Antes");
    expect((await row(unrelated)).status).toBe("OPEN");
    expect((await row(bare)).status).toBe("OPEN");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args[1]).sort()).toEqual(["IN_PROGRESS", "OPEN"]);
  });

  it("returns nothing when no ticket is linked", async () => {
    const published = await program(a.id, 1, "ACTIVO");

    expect((await service.adminResolveLinked(a.id, published.id, admin, "Hecho")).resolved).toEqual(
      []
    );
  });

  it("does not touch another clinic's tickets even if linked to the same id", async () => {
    const published = await program(a.id, 1, "ACTIVO");
    const foreign = await file(b);

    await db.changeRequest.update({ where: { id: foreign.id }, data: { programId: published.id } });
    const res = await service.adminResolveLinked(a.id, published.id, admin, "Hecho");

    expect(res.resolved).toEqual([]);
    expect((await row(foreign.id)).status).toBe("OPEN");
  });

  it("409s for a draft or superseded programme, 404s for another clinic's, and needs a note", async () => {
    const draft = await program(a.id, 2, "BORRADOR");
    const old = await program(a.id, 1, "SUSTITUIDO");
    const t = await linked(a, draft.id);

    await expect(service.adminResolveLinked(a.id, draft.id, admin, "Hecho")).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    await expect(service.adminResolveLinked(a.id, old.id, admin, "Hecho")).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    await expect(service.adminResolveLinked(a.id, draft.id, admin, "  ")).rejects.toBeInstanceOf(
      ChangeRequestValidationError
    );
    await expect(service.adminResolveLinked(b.id, draft.id, admin, "Hecho")).rejects.toBeInstanceOf(
      ProgrammeNotFoundError
    );
    await expect(
      service.adminResolveLinked(a.id, "00000000-0000-0000-0000-000000000000", admin, "Hecho")
    ).rejects.toBeInstanceOf(ProgrammeNotFoundError);
    expect((await row(t)).status).toBe("OPEN");
  });
});
