import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeRequestConflictError,
  ChangeRequestNotFoundError
} from "../../src/common/errors/change-request.errors";
import { PrismaCatalogueChanges } from "../../src/modules/change-requests/catalogue-changes";
import type { ChangeRequestNotifier } from "../../src/modules/change-requests/notifier";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
import { ChangeRequestService } from "../../src/modules/change-requests/service";

/**
 * Applying a ticket through the real treatment and bono services, on the database. Slugs are
 * unique to this file (vitest runs files in parallel on one database).
 */
const db = new PrismaClient();
const SLUGS = ["test-cr-apply-cat", "test-cr-apply-plain", "test-cr-apply-other"];

let cat: Clinic;
let plain: Clinic;
let other: Clinic;

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
  changes: new PrismaCatalogueChanges(db)
});

const owner = { email: "dueno@apply.test", role: "OWNER" as const };
const admin = { email: "admin@voone.test" };

const wipe = async () => {
  await db.changeRequest.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.bonoPlan.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.catalogItem.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.clinicTreatment.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.onboardingProgram.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
};

const item = (clinicId: string, externalId: string, name: string, priceCents: number) =>
  db.catalogItem.create({
    data: { clinicId, externalId, name, priceCents, categoryId: "FAC", position: 0 }
  });

const reward = (n: number, name: string, id: string) => ({
  m: { n },
  o: { items: [{ id, name }] },
  alts: []
});

let bio: { id: string };
let peel: { id: string };
let spare: { id: string };

beforeAll(async () => {
  const make = (slug: string) =>
    db.clinic.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug, addressLine: "Calle Prueba 4", pincode: "28001" }
    });

  cat = await make(SLUGS[0]!);
  plain = await make(SLUGS[1]!);
  other = await make(SLUGS[2]!);
});

beforeEach(async () => {
  calls.length = 0;
  await wipe();
  bio = await item(cat.id, "ext-bio", "Bio-Pen", 15000);
  peel = await item(cat.id, "ext-peel", "Peeling", 8000);
  spare = await item(cat.id, "ext-spare", "Spare", 5000);
  await db.onboardingProgram.create({
    data: {
      clinicId: cat.id,
      version: 2,
      status: "ACTIVO",
      engineVersion: "t",
      configVersion: "t",
      answers: {},
      catalogSnapshot: [],
      output: {
        chosen: [reward(3, "Bio-Pen", "ext-bio"), reward(5, "Other", "ext-zzz")],
        rec: { every: 4, o: { items: [{ id: "ext-peel", name: "Peeling" }] } }
      }
    }
  });
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

const file = async (clinic: Clinic, input: Record<string, unknown>) => {
  const ticket = await service.create(clinic.id, owner, {
    title: "Cambio",
    reason: "Por favor.",
    ...input
  } as never);

  calls.length = 0;

  return ticket;
};

const row = (id: string) => db.changeRequest.findUniqueOrThrow({ where: { id } });

describe("apply: services", () => {
  it("SERVICE_EDIT updates the treatment, resolves the ticket and tells the notifier", async () => {
    const t = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: bio.id },
      proposed: { name: "Bio-Pen Pro", priceEuro: 175.5 }
    });
    const res = await service.adminApply(t.id, admin);

    const updated = await db.catalogItem.findUniqueOrThrow({ where: { id: bio.id } });

    expect(updated).toMatchObject({ name: "Bio-Pen Pro", priceCents: 17550 });
    expect(res.request.status).toBe("RESOLVED");
    expect(res.request.resolvedByEmail).toBe("admin@voone.test");
    expect(res.request.resolutionNote).toMatch(/^Applied: /);
    expect(res.request.resolutionNote).toContain("Bio-Pen");
    expect(res.applied.summary).toContain("Bio-Pen Pro");
    expect(res.applied).toMatchObject({ action: "updated" });
    const stored = await row(t.id);

    expect(stored.status).toBe("RESOLVED");
    expect(stored.resolvedAt).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1)).toEqual(["OPEN", "VOONE"]);
  });

  it("uses the admin's note as the resolution note when given", async () => {
    const t = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: peel.id },
      proposed: { priceEuro: 90 }
    });
    const res = await service.adminApply(t.id, admin, "  Done as asked  ");

    expect(res.request.resolutionNote).toBe("Done as asked");
  });

  it("SERVICE_ADD creates the treatment; SERVICE_REMOVE deletes it", async () => {
    const add = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "Nuevo", priceEuro: 60, categoryId: "FAC" }
    });
    const added = await service.adminApply(add.id, admin);

    expect(added.applied).toMatchObject({ action: "created" });
    expect(await db.catalogItem.count({ where: { clinicId: cat.id, name: "Nuevo" } })).toBe(1);

    const remove = await file(cat, {
      type: "SERVICE_REMOVE",
      targetRef: { treatmentId: spare.id }
    });
    const removed = await service.adminApply(remove.id, admin);

    expect(removed.applied).toMatchObject({ action: "removed" });
    expect(await db.catalogItem.count({ where: { id: spare.id } })).toBe(0);
    expect(removed.request.status).toBe("RESOLVED");
  });

  it("works on a plain centre's treatments (whole euros)", async () => {
    const t0 = await db.clinicTreatment.create({
      data: { clinicId: plain.id, name: "Masaje", priceEuro: 40, pointsAllotted: 400 }
    });
    const t = await file(plain, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: t0.id },
      proposed: { priceEuro: 55 }
    });
    const res = await service.adminApply(t.id, admin);

    expect((await db.clinicTreatment.findUniqueOrThrow({ where: { id: t0.id } })).priceEuro).toBe(
      55
    );
    // No active programme: nothing to recalibrate.
    expect(res.warnings).toEqual([]);
  });

  it("BONO add, edit and remove go through the plan service", async () => {
    const add = await file(plain, {
      type: "BONO",
      proposed: { action: "add", name: "Bono 5", priceEuro: 200, totalSessions: 5 }
    });
    const added = await service.adminApply(add.id, admin);
    const plan = await db.bonoPlan.findFirstOrThrow({ where: { clinicId: plain.id } });

    expect(added.applied).toMatchObject({ action: "created" });
    expect(plan).toMatchObject({ name: "Bono 5", totalSessions: 5, pricePerSessionCents: 4000 });

    const edit = await file(plain, {
      type: "BONO",
      targetRef: { bonoId: plan.id },
      proposed: { action: "edit", priceEuro: 150 }
    });

    await service.adminApply(edit.id, admin);
    expect(
      (await db.bonoPlan.findUniqueOrThrow({ where: { id: plan.id } })).pricePerSessionCents
    ).toBe(3000);

    const remove = await file(plain, {
      type: "BONO",
      targetRef: { bonoId: plan.id },
      proposed: { action: "remove" }
    });
    const removed = await service.adminApply(remove.id, admin);

    expect(removed.applied).toMatchObject({ action: "deleted" });
    expect(await db.bonoPlan.count({ where: { id: plan.id } })).toBe(0);
  });
});

describe("apply: refusals leave everything as it was", () => {
  it("is idempotent: a second apply is a 409 and changes nothing more", async () => {
    const t = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "Una vez", priceEuro: 10, categoryId: "FAC" }
    });

    await service.adminApply(t.id, admin);
    calls.length = 0;
    await expect(service.adminApply(t.id, admin)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    expect(await db.catalogItem.count({ where: { clinicId: cat.id, name: "Una vez" } })).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("two simultaneous applies add the treatment once", async () => {
    const t = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "Carrera", priceEuro: 10, categoryId: "FAC" }
    });
    const results = await Promise.allSettled([
      service.adminApply(t.id, admin),
      service.adminApply(t.id, admin),
      service.adminApply(t.id, admin)
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ChangeRequestConflictError);
    }
    expect(await db.catalogItem.count({ where: { clinicId: cat.id, name: "Carrera" } })).toBe(1);
  });

  it("409s with a clear message when the target treatment is gone, and the ticket stays open", async () => {
    const t = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: spare.id },
      proposed: { priceEuro: 9 }
    });

    await db.catalogItem.delete({ where: { id: spare.id } });
    const error = (await service.adminApply(t.id, admin).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ChangeRequestConflictError);
    expect(error.message).toMatch(/no longer exists/i);
    expect((await row(t.id)).status).toBe("OPEN");
  });

  it("409s when the target bono is gone", async () => {
    const t = await file(plain, {
      type: "BONO",
      targetRef: { bonoId: "00000000-0000-0000-0000-000000000000" },
      proposed: { action: "remove" }
    });

    await expect(service.adminApply(t.id, admin)).rejects.toThrow(/no longer exists/i);
    expect((await row(t.id)).status).toBe("OPEN");
  });

  it("409s on values the catalogue now refuses, and writes nothing", async () => {
    // A catalogue centre needs a category on a new treatment; the ticket has none.
    const t = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "Sin categoría", priceEuro: 10 }
    });
    const error = (await service.adminApply(t.id, admin).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ChangeRequestConflictError);
    expect(error.message).toMatch(/not valid/i);
    expect(await db.catalogItem.count({ where: { clinicId: cat.id, name: "Sin categoría" } })).toBe(
      0
    );
    expect((await row(t.id)).status).toBe("OPEN");
  });

  it("never touches another clinic's treatment named in a ticket", async () => {
    const t = await file(other, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: bio.id },
      proposed: { name: "Hackeado" }
    });

    await expect(service.adminApply(t.id, admin)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    expect((await db.catalogItem.findUniqueOrThrow({ where: { id: bio.id } })).name).toBe(
      "Bio-Pen"
    );
  });

  it("refuses types that cannot be applied and tickets already closed", async () => {
    for (const type of ["REWARD", "LEVEL", "OTHER"]) {
      const t = await file(cat, { type });

      await expect(service.adminApply(t.id, admin)).rejects.toBeInstanceOf(
        ChangeRequestConflictError
      );
    }

    const closed = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "Cerrado", priceEuro: 10, categoryId: "FAC" }
    });

    await service.adminSetStatus(closed.id, admin, { status: "REJECTED", resolutionNote: "No" });
    await expect(service.adminApply(closed.id, admin)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
    expect(await db.catalogItem.count({ where: { clinicId: cat.id, name: "Cerrado" } })).toBe(0);
    await expect(service.adminApply("nope", admin)).rejects.toBeInstanceOf(
      ChangeRequestNotFoundError
    );
  });

  it("applies an IN_PROGRESS ticket", async () => {
    const t = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "En curso", priceEuro: 10, categoryId: "FAC" }
    });

    await service.adminSetStatus(t.id, admin, { status: "IN_PROGRESS" });
    calls.length = 0;
    const res = await service.adminApply(t.id, admin);

    expect(res.request.status).toBe("RESOLVED");
    expect(calls[0]!.args[1]).toBe("IN_PROGRESS");
  });
});

describe("catalogue drift warnings", () => {
  it("names the programme version and the live rewards that use the edited treatment", async () => {
    const t = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: bio.id },
      proposed: { priceEuro: 200 }
    });
    const res = await service.adminApply(t.id, admin);

    expect(res.warnings).toEqual([
      "The catalogue changed since the active programme (v2) was built: consider recalibrating.",
      'Milestone 3 reward "Bio-Pen" uses this treatment.'
    ]);
  });

  it("names the recurring reward and works for a removal", async () => {
    const t = await file(cat, { type: "SERVICE_REMOVE", targetRef: { treatmentId: peel.id } });
    const res = await service.adminApply(t.id, admin);

    expect(res.warnings[0]).toContain("(v2)");
    expect(res.warnings.some((w) => w.includes("recurring reward") && w.includes("Peeling"))).toBe(
      true
    );
  });

  it("adds only the general warning for a new treatment, and none without an active programme", async () => {
    const add = await file(cat, {
      type: "SERVICE_ADD",
      proposed: { name: "Nuevo", priceEuro: 60, categoryId: "FAC" }
    });

    expect((await service.adminApply(add.id, admin)).warnings).toHaveLength(1);

    await db.onboardingProgram.deleteMany({ where: { clinicId: cat.id } });
    const again = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: bio.id },
      proposed: { priceEuro: 1 }
    });

    expect((await service.adminApply(again.id, admin)).warnings).toEqual([]);
  });

  it("ignores a draft programme: only an ACTIVE one counts", async () => {
    await db.onboardingProgram.updateMany({
      where: { clinicId: cat.id },
      data: { status: "BORRADOR" }
    });
    const t = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: bio.id },
      proposed: { priceEuro: 1 }
    });

    expect((await service.adminApply(t.id, admin)).warnings).toEqual([]);
  });

  it("shows catalogueImpact on the admin detail of an open service ticket, null otherwise", async () => {
    const edit = await file(cat, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: bio.id },
      proposed: { priceEuro: 200 }
    });
    const detail = await service.adminGet(edit.id);

    expect(detail.catalogueImpact).toEqual([
      "Applying this will change the catalogue compared with the active programme (v2): consider recalibrating.",
      'Milestone 3 reward "Bio-Pen" uses this treatment.'
    ]);

    const other = await file(cat, { type: "OTHER" });
    const bono = await file(cat, {
      type: "BONO",
      proposed: { action: "add", name: "B", priceEuro: 10, totalSessions: 2 }
    });

    expect((await service.adminGet(other.id)).catalogueImpact).toBeNull();
    // Bono plans do not feed the programme's catalogue.
    expect((await service.adminGet(bono.id)).catalogueImpact).toBeNull();

    await service.adminApply(edit.id, admin);
    expect((await service.adminGet(edit.id)).catalogueImpact).toBeNull();
  });
});
