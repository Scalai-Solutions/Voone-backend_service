import { PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChangeRequestConflictError } from "../../src/common/errors/change-request.errors";
import {
  TreatmentNotFoundError,
  TreatmentValidationError
} from "../../src/common/errors/treatment.errors";
import { PrismaCatalogueChanges } from "../../src/modules/change-requests/catalogue-changes";
import type { ChangeRequestNotifier } from "../../src/modules/change-requests/notifier";
import { PrismaChangeRequestRepository } from "../../src/modules/change-requests/prisma.repository";
import { ChangeRequestService } from "../../src/modules/change-requests/service";

/**
 * A centre's own treatment and bono changes: filed and applied in the same moment, recorded as a
 * resolved, auto-approved ticket. Rewards, levels and anything else still wait for Voone.
 * Slugs are unique to this file (vitest runs files in parallel on one database).
 */
const db = new PrismaClient();
const SLUGS = ["test-cr-auto-cat", "test-cr-auto-plain"];

let cat: Clinic;
let plain: Clinic;

const mails: string[] = [];
const recorder: ChangeRequestNotifier = {
  onCreated: async () => void mails.push("onCreated"),
  onOwnerReply: async () => void mails.push("onOwnerReply"),
  onAdminReply: async () => {},
  onStatusChanged: async () => void mails.push("onStatusChanged")
};

const build = (autoApprove?: boolean) =>
  new ChangeRequestService(new PrismaChangeRequestRepository(db), {
    notifier: recorder,
    background: (task) => task,
    changes: new PrismaCatalogueChanges(db),
    ...(autoApprove === undefined ? {} : { autoApprove })
  });

const service = build(true);
const owner = { email: "dueno@auto.test", role: "OWNER" as const };
const admin = { email: "admin@voone.test" };

const wipe = async () => {
  await db.changeRequest.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.bonoPlan.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.catalogItem.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.clinicTreatment.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
  await db.onboardingProgram.deleteMany({ where: { clinic: { slug: { in: SLUGS } } } });
};

let counter = 0;
const file = (clinic: Clinic, input: Record<string, unknown>, who = service) =>
  who.create(clinic.id, owner, {
    title: `Cambio ${++counter}`,
    reason: "Cambio hecho desde el panel.",
    ...input
  } as never);

const stored = (clinicId: string) =>
  db.changeRequest.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  const make = (slug: string) =>
    db.clinic.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug, addressLine: "Calle Prueba 5", pincode: "28001" }
    });

  cat = await make(SLUGS[0]!);
  plain = await make(SLUGS[1]!);
});

beforeEach(async () => {
  mails.length = 0;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

describe("a treatment change by the centre", () => {
  it("adds the treatment and stores one resolved, applied, auto-approved ticket", async () => {
    const view = await file(plain, {
      type: "SERVICE_ADD",
      proposed: { name: "Masaje", priceEuro: 40 }
    });

    expect(view).toMatchObject({ status: "RESOLVED", autoApproved: true, type: "SERVICE_ADD" });
    expect(view.resolutionNote).toMatch(/^Aprobada y aplicada automáticamente\./);
    expect(view.reopenableUntil).toBeNull();
    expect(await db.clinicTreatment.count({ where: { clinicId: plain.id, name: "Masaje" } })).toBe(
      1
    );

    const [row] = await stored(plain.id);

    expect(row).toMatchObject({
      status: "RESOLVED",
      autoApproved: true,
      createdByEmail: owner.email,
      resolvedByEmail: owner.email,
      appliedByEmail: owner.email
    });
    expect(row!.appliedAt).not.toBeNull();
    expect(row!.resolvedAt).not.toBeNull();
  });

  it("edits and removes a treatment the same way", async () => {
    const t0 = await db.clinicTreatment.create({
      data: { clinicId: plain.id, name: "Masaje", priceEuro: 40, pointsAllotted: 400 }
    });

    await file(plain, {
      type: "SERVICE_EDIT",
      targetRef: { treatmentId: t0.id },
      proposed: { priceEuro: 55 }
    });
    expect((await db.clinicTreatment.findUniqueOrThrow({ where: { id: t0.id } })).priceEuro).toBe(
      55
    );

    await file(plain, { type: "SERVICE_REMOVE", targetRef: { treatmentId: t0.id } });
    expect(await db.clinicTreatment.count({ where: { id: t0.id } })).toBe(0);
    expect((await stored(plain.id)).map((r) => r.autoApproved)).toEqual([true, true]);
  });

  it("applies a bono plan change, add, edit and remove", async () => {
    await file(plain, {
      type: "BONO",
      proposed: { action: "add", name: "Bono facial", priceEuro: 200, totalSessions: 5 }
    });

    const plan = await db.bonoPlan.findFirstOrThrow({ where: { clinicId: plain.id } });

    await file(plain, {
      type: "BONO",
      targetRef: { bonoId: plan.id },
      proposed: { action: "edit", totalSessions: 6 }
    });
    expect((await db.bonoPlan.findUniqueOrThrow({ where: { id: plan.id } })).totalSessions).toBe(6);

    await file(plain, {
      type: "BONO",
      targetRef: { bonoId: plan.id },
      proposed: { action: "remove" }
    });
    expect((await stored(plain.id)).every((r) => r.status === "RESOLVED" && r.autoApproved)).toBe(
      true
    );
  });

  it("does not mail anyone: the ticket is the record", async () => {
    await file(plain, { type: "SERVICE_ADD", proposed: { name: "Masaje", priceEuro: 40 } });

    expect(mails).toEqual([]);
  });

  it("is not held back by twenty unresolved tickets, and is not mistaken for a retry", async () => {
    for (let i = 0; i < 21; i += 1) {
      await db.changeRequest.create({
        data: {
          clinicId: plain.id,
          type: "OTHER",
          title: `Abierta ${i}`,
          reason: "Pendiente.",
          createdByEmail: owner.email,
          createdByRole: "OWNER"
        }
      });
    }

    const t0 = await db.clinicTreatment.create({
      data: { clinicId: plain.id, name: "Masaje", priceEuro: 40, pointsAllotted: 400 }
    });
    const edit = (priceEuro: number) =>
      service.create(plain.id, owner, {
        type: "SERVICE_EDIT",
        title: "Cambio de precio",
        reason: "Cambio hecho desde el panel.",
        targetRef: { treatmentId: t0.id },
        proposed: { priceEuro }
      } as never);

    // 50, 60, 50: the same title and reason three times inside a minute. Each is its own change.
    await edit(50);
    await edit(60);
    await edit(50);

    expect((await db.clinicTreatment.findUniqueOrThrow({ where: { id: t0.id } })).priceEuro).toBe(
      50
    );
    expect(
      await db.changeRequest.count({ where: { clinicId: plain.id, autoApproved: true } })
    ).toBe(3);
  });
});

describe("a change the catalogue refuses", () => {
  it("answers in the catalogue's own words and stores nothing", async () => {
    await db.catalogItem.create({
      data: {
        clinicId: cat.id,
        externalId: "ext-uno",
        name: "Uno",
        priceCents: 5000,
        categoryId: "FAC",
        position: 0
      }
    });

    await expect(
      file(cat, { type: "SERVICE_ADD", proposed: { name: "Sin categoría", priceEuro: 40 } })
    ).rejects.toBeInstanceOf(TreatmentValidationError);

    expect(await stored(cat.id)).toEqual([]);
    expect(await db.catalogItem.count({ where: { clinicId: cat.id } })).toBe(1);
  });

  it("says so when the treatment is already gone", async () => {
    await expect(
      file(plain, {
        type: "SERVICE_EDIT",
        targetRef: { treatmentId: "ya-no-existe" },
        proposed: { priceEuro: 10 }
      })
    ).rejects.toBeInstanceOf(TreatmentNotFoundError);

    expect(await stored(plain.id)).toEqual([]);
  });
});

describe("what the centre is told about its own change", () => {
  it("warns, in Spanish and on the ticket, that a live reward uses a treatment it removes", async () => {
    const bio = await db.catalogItem.create({
      data: {
        clinicId: cat.id,
        externalId: "ext-bio",
        name: "Bio-Pen",
        priceCents: 15000,
        categoryId: "FAC",
        position: 0
      }
    });

    await db.catalogItem.create({
      data: {
        clinicId: cat.id,
        externalId: "ext-otro",
        name: "Otro",
        priceCents: 5000,
        categoryId: "FAC",
        position: 1
      }
    });
    await db.onboardingProgram.create({
      data: {
        clinicId: cat.id,
        version: 1,
        status: "ACTIVO",
        engineVersion: "t",
        configVersion: "t",
        answers: {},
        catalogSnapshot: [],
        output: {
          chosen: [{ m: { n: 3 }, o: { items: [{ id: "ext-bio", name: "Bio-Pen" }] }, alts: [] }],
          rec: { every: 4, o: { items: [{ id: "ext-zzz", name: "Otro" }] } }
        }
      }
    });

    const view = await file(cat, { type: "SERVICE_REMOVE", targetRef: { treatmentId: bio.id } });

    expect(await db.catalogItem.count({ where: { id: bio.id } })).toBe(0);
    expect(view.warnings).toEqual([
      expect.stringContaining("conviene recalibrarlo"),
      expect.stringContaining("El premio del hito 3, «Bio-Pen», usa este tratamiento.")
    ]);
    expect(view.resolutionNote).toContain("usa este tratamiento");
  });

  it("has no warnings when there is no active programme", async () => {
    const view = await file(plain, {
      type: "SERVICE_ADD",
      proposed: { name: "Masaje", priceEuro: 40 }
    });

    expect(view.warnings).toEqual([]);
  });
});

describe("what still waits for Voone", () => {
  it.each([
    ["REWARD", {}],
    ["LEVEL", {}],
    ["OTHER", {}]
  ])("a %s ticket stays open and Voone is told", async (type, extra) => {
    const view = await file(plain, { type, ...extra });

    expect(view).toMatchObject({ status: "OPEN", autoApproved: false });
    expect(mails).toEqual(["onCreated"]);
  });

  it("a treatment ticket stays open when the service does not auto-approve", async () => {
    const view = await file(
      plain,
      { type: "SERVICE_ADD", proposed: { name: "Masaje", priceEuro: 40 } },
      build(false)
    );

    expect(view).toMatchObject({ status: "OPEN", autoApproved: false });
    expect(await db.clinicTreatment.count({ where: { clinicId: plain.id } })).toBe(0);
  });
});

describe("an automatic ticket is a record, not a request", () => {
  it("is not reopened by the centre, and its status is not changed by Voone", async () => {
    const view = await file(plain, {
      type: "SERVICE_ADD",
      proposed: { name: "Masaje", priceEuro: 40 }
    });

    await expect(service.reopenAsClinic(plain.id, view.id, owner)).rejects.toMatchObject({
      code: "CHANGE_REQUEST_AUTO_APPROVED"
    });
    await expect(
      service.replyAsClinic(plain.id, view.id, owner, "¿Puedo deshacerlo?")
    ).rejects.toBeInstanceOf(ChangeRequestConflictError);
    await expect(service.adminSetStatus(view.id, admin, { status: "OPEN" })).rejects.toMatchObject({
      code: "CHANGE_REQUEST_AUTO_APPROVED"
    });
    await expect(service.adminApply(view.id, admin)).rejects.toBeInstanceOf(
      ChangeRequestConflictError
    );
  });

  it("shows to Voone as automatic, in the list and in the detail", async () => {
    const view = await file(plain, {
      type: "SERVICE_ADD",
      proposed: { name: "Masaje", priceEuro: 40 }
    });
    const detail = await service.adminGet(view.id);
    const list = await service.adminList({ clinicId: plain.id, limit: 10 });

    expect(detail.autoApproved).toBe(true);
    expect(list.items[0]!.autoApproved).toBe(true);
  });
});
