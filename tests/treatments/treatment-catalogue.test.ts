import { OnboardingProgramStatus, PrismaClient, VisitKind } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  TreatmentNotFoundError,
  TreatmentValidationError
} from "../../src/common/errors/treatment.errors";
import {
  createTreatment,
  listTreatments,
  removeTreatment,
  scanScreenTreatments,
  treatmentCategories,
  updateTreatment,
  usesCatalogue
} from "../../src/modules/treatments/treatment-catalogue.service";
import { CATEGORIES } from "../../src/modules/onboarding/engine.config";

/**
 * The owner's treatment editor, against a real database.
 *
 * Which table a write lands in is the whole risk: the scan screen reads CatalogItem at a
 * programme centre and ClinicTreatment elsewhere, so a write to the wrong one is a change
 * the owner makes and never sees.
 */
const db = new PrismaClient();

const SLUGS = ["tr-programme", "tr-plain", "tr-other", "tr-onboarding", "tr-empty-programme"];
let programme: { id: string };
let plain: { id: string };
let other: { id: string };
let onboarding: { id: string };
let emptyProgramme: { id: string };
let seedItem: { id: string };

const wipe = async (): Promise<void> => {
  const ids = (await db.clinic.findMany({ where: { slug: { in: SLUGS } } })).map((c) => c.id);

  await db.paidVisit.deleteMany({ where: { clinicId: { in: ids } } });
  await db.member.deleteMany({ where: { clinicId: { in: ids } } });
  await db.clinicTreatment.deleteMany({ where: { clinicId: { in: ids } } });
  await db.catalogItem.deleteMany({ where: { clinicId: { in: ids } } });
  await db.onboardingProgram.deleteMany({ where: { clinicId: { in: ids } } });
};

const makeClinic = (slug: string) =>
  db.clinic.upsert({
    where: { slug },
    update: {},
    create: { slug, name: slug, addressLine: "Calle Uno 1", pincode: "28001" }
  });

beforeAll(async () => {
  programme = await makeClinic(SLUGS[0]);
  plain = await makeClinic(SLUGS[1]);
  other = await makeClinic(SLUGS[2]);
  onboarding = await makeClinic(SLUGS[3]);
  emptyProgramme = await makeClinic(SLUGS[4]);
});

const activeProgramme = (clinicId: string) =>
  db.onboardingProgram.create({
    data: {
      clinicId,
      version: 1,
      status: OnboardingProgramStatus.ACTIVO,
      engineVersion: "t",
      configVersion: "t",
      answers: {},
      output: {},
      catalogSnapshot: []
    }
  });

beforeEach(async () => {
  await wipe();
  // A programme centre as it is in practice: a live programme and an imported catalogue.
  await activeProgramme(programme.id);
  seedItem = await db.catalogItem.create({
    data: {
      clinicId: programme.id,
      externalId: "seed",
      name: "Existente",
      priceCents: 1000,
      categoryId: "FAC",
      position: 0
    }
  });
});

afterAll(async () => {
  await wipe();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

const message = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(TreatmentValidationError);

    return (error as Error).message;
  }

  throw new Error("expected a validation error");
};

describe("creating at a programme centre", () => {
  it("writes a catalogue row the scan screen reads, and never a ClinicTreatment", async () => {
    const row = await createTreatment(db, programme.id, {
      name: "Limpieza facial",
      priceEuro: 45.5,
      categoryId: "FAC"
    });

    expect(row).toMatchObject({
      name: "Limpieza facial",
      priceEuro: 45.5,
      categoryId: "FAC",
      points: 455
    });

    const stored = await db.catalogItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({
      clinicId: programme.id,
      priceCents: 4550,
      isProduct: false,
      needsReview: false,
      classificationSource: "centro",
      estimated: false,
      costPctOverride: null
    });
    expect(stored.externalId).toMatch(/^owner-/);
    expect(await db.clinicTreatment.count({ where: { clinicId: programme.id } })).toBe(0);

    expect((await listTreatments(db, programme.id)).map((t) => t.id)).toEqual([
      seedItem.id,
      row.id
    ]);
  });

  it("appends after the existing rows", async () => {
    await db.catalogItem.create({
      data: { clinicId: programme.id, externalId: "x1", name: "A", priceCents: 1000, position: 7 }
    });
    const row = await createTreatment(db, programme.id, {
      name: "B",
      priceEuro: 20,
      categoryId: "FAC"
    });

    const stored = await db.catalogItem.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.position).toBe(8);
  });

  it("rejects a category the engine does not know, and a missing one", async () => {
    for (const categoryId of ["ZZZ", "toString", undefined]) {
      expect(
        await message(createTreatment(db, programme.id, { name: "X", priceEuro: 10, categoryId }))
      ).toBe("Elige una categoría de la lista.");
    }

    // Only the seed row: nothing was written.
    expect(await db.catalogItem.count({ where: { clinicId: programme.id } })).toBe(1);
  });
});

describe("creating at a plain centre", () => {
  it("writes a ClinicTreatment at ten points per euro and ignores the category", async () => {
    const row = await createTreatment(db, plain.id, { name: "Masaje", priceEuro: 60 });

    expect(row).toMatchObject({ name: "Masaje", priceEuro: 60, points: 600, categoryId: null });
    expect(await db.catalogItem.count({ where: { clinicId: plain.id } })).toBe(0);
    expect(await db.clinicTreatment.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      clinicId: plain.id,
      priceEuro: 60,
      pointsAllotted: 600
    });

    const withIgnoredCategory = await createTreatment(db, plain.id, {
      name: "Otro",
      priceEuro: 5,
      categoryId: "not-a-category"
    });
    expect(withIgnoredCategory.categoryId).toBeNull();
  });

  it("needs a whole number of euros, because that is what the store holds", async () => {
    await expect(
      createTreatment(db, plain.id, { name: "Masaje", priceEuro: 60.5 })
    ).rejects.toBeInstanceOf(TreatmentValidationError);
  });
});

describe("validation", () => {
  it.each([0, -5, 100001, 0.001, 12.345, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the price %s with the Spanish message",
    async (priceEuro) => {
      for (const clinicId of [programme.id, plain.id]) {
        expect(
          await message(createTreatment(db, clinicId, { name: "X", priceEuro, categoryId: "FAC" }))
        ).toBe("El precio debe estar entre 0,01 € y 100.000 €.");
      }
    }
  );

  it("accepts the bounds", async () => {
    expect(
      (await createTreatment(db, programme.id, { name: "Min", priceEuro: 0.01, categoryId: "FAC" }))
        .priceEuro
    ).toBe(0.01);
    expect(
      (
        await createTreatment(db, programme.id, {
          name: "Max",
          priceEuro: 100000,
          categoryId: "FAC"
        })
      ).priceEuro
    ).toBe(100000);
  });

  it("rejects a blank name", async () => {
    expect(await message(createTreatment(db, plain.id, { name: "   ", priceEuro: 10 }))).toBe(
      "Escribe el nombre del tratamiento."
    );
  });

  it("rejects an update to a bad price or category without changing the row", async () => {
    const row = await createTreatment(db, programme.id, {
      name: "A",
      priceEuro: 10,
      categoryId: "FAC"
    });

    expect(await message(updateTreatment(db, programme.id, row.id, { priceEuro: 0 }))).toBe(
      "El precio debe estar entre 0,01 € y 100.000 €."
    );
    expect(await message(updateTreatment(db, programme.id, row.id, { categoryId: "ZZZ" }))).toBe(
      "Elige una categoría de la lista."
    );
    expect(await db.catalogItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      priceCents: 1000,
      categoryId: "FAC"
    });
  });
});

describe("updating", () => {
  it("changes only what was sent", async () => {
    const row = await createTreatment(db, programme.id, {
      name: "A",
      priceEuro: 10,
      categoryId: "FAC"
    });

    const renamed = await updateTreatment(db, programme.id, row.id, { name: "  B  " });
    expect(renamed).toMatchObject({ name: "B", priceEuro: 10, categoryId: "FAC" });

    const repriced = await updateTreatment(db, programme.id, row.id, { priceEuro: 12.5 });
    expect(repriced).toMatchObject({ name: "B", priceEuro: 12.5, points: 125 });
  });

  it("recomputes a plain centre's points only when the price changes", async () => {
    const row = await createTreatment(db, plain.id, { name: "A", priceEuro: 10 });
    await db.clinicTreatment.update({ where: { id: row.id }, data: { pointsAllotted: 7 } });

    expect((await updateTreatment(db, plain.id, row.id, { name: "B" })).points).toBe(7);
    expect((await updateTreatment(db, plain.id, row.id, { priceEuro: 20 })).points).toBe(200);
  });

  it("does not reach a ClinicTreatment the scan screen is not showing", async () => {
    const hidden = await db.clinicTreatment.create({
      data: { clinicId: programme.id, name: "Antiguo", priceEuro: 30, pointsAllotted: 300 }
    });

    // The centre has catalogue rows, so the scan screen shows those and not this one.
    await expect(
      updateTreatment(db, programme.id, hidden.id, { name: "Nuevo" })
    ).rejects.toBeInstanceOf(TreatmentNotFoundError);
    await expect(removeTreatment(db, programme.id, hidden.id)).rejects.toBeInstanceOf(
      TreatmentNotFoundError
    );
    expect((await db.clinicTreatment.findUniqueOrThrow({ where: { id: hidden.id } })).name).toBe(
      "Antiguo"
    );
  });
});

describe("another clinic's id", () => {
  it("is a 404 for update and delete, and the row is untouched", async () => {
    const theirs = await createTreatment(db, programme.id, {
      name: "Suyo",
      priceEuro: 10,
      categoryId: "FAC"
    });
    const theirsPlain = await createTreatment(db, plain.id, { name: "Suyo", priceEuro: 10 });

    for (const id of [theirs.id, theirsPlain.id, "no-such-id"]) {
      for (const run of [
        () => updateTreatment(db, other.id, id, { name: "Mío" }),
        () => removeTreatment(db, other.id, id)
      ]) {
        const error = await run().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TreatmentNotFoundError);
        expect((error as Error).message).toBe("No se ha encontrado ese tratamiento.");
        expect((error as { statusCode: number }).statusCode).toBe(404);
      }
    }

    expect((await db.catalogItem.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe(
      "Suyo"
    );
    expect(
      (await db.clinicTreatment.findUniqueOrThrow({ where: { id: theirsPlain.id } })).name
    ).toBe("Suyo");
  });
});

describe("deleting", () => {
  it("removes the row and leaves recorded visits exactly as they were", async () => {
    const row = await createTreatment(db, programme.id, {
      name: "A",
      priceEuro: 80,
      categoryId: "FAC"
    });
    const member = await db.member.create({
      data: {
        clinicId: programme.id,
        name: "Clienta",
        phone: "+34600001234",
        code: "TRX01",
        consentMarketing: false,
        consentSource: "staff_entry"
      }
    });
    const visit = await db.paidVisit.create({
      data: {
        clinicId: programme.id,
        memberId: member.id,
        kind: VisitKind.PAYMENT,
        amountCents: 8000,
        idempotencyKey: "tr-visit-1",
        occurredAt: new Date("2026-10-01T10:00:00Z")
      }
    });

    await removeTreatment(db, programme.id, row.id);

    expect((await listTreatments(db, programme.id)).map((t) => t.id)).toEqual([seedItem.id]);
    expect(await db.paidVisit.findUniqueOrThrow({ where: { id: visit.id } })).toEqual(visit);
  });

  it("removes a plain centre's treatment from its own table", async () => {
    const row = await createTreatment(db, plain.id, { name: "A", priceEuro: 10 });

    await removeTreatment(db, plain.id, row.id);

    expect(await db.clinicTreatment.count({ where: { clinicId: plain.id } })).toBe(0);
  });
});

describe("listing", () => {
  it("keeps the scan screen's order and shape, plus the category", async () => {
    await db.catalogItem.deleteMany({ where: { clinicId: programme.id } });
    await db.catalogItem.createMany({
      data: [
        {
          clinicId: programme.id,
          externalId: "b",
          name: "B",
          priceCents: 4000,
          position: 2,
          categoryId: "MAS"
        },
        { clinicId: programme.id, externalId: "a", name: "A", priceCents: 1250, position: 1 },
        {
          clinicId: programme.id,
          externalId: "p",
          name: "Crema",
          priceCents: 900,
          position: 0,
          isProduct: true
        }
      ]
    });

    const rows = await listTreatments(db, programme.id);

    expect(rows.map((r) => [r.name, r.priceEuro, r.points, r.categoryId])).toEqual([
      ["A", 12.5, 125, null],
      ["B", 40, 400, "MAS"]
    ]);
  });

  it("falls back to ClinicTreatment, sorted by name, when there is no catalogue", async () => {
    await db.clinicTreatment.createMany({
      data: [
        { clinicId: plain.id, name: "Zeta", priceEuro: 10, pointsAllotted: 3 },
        { clinicId: plain.id, name: "Alfa", priceEuro: null, pointsAllotted: 5 }
      ]
    });

    expect(
      (await listTreatments(db, plain.id)).map((r) => [r.name, r.priceEuro, r.points])
    ).toEqual([
      ["Alfa", null, 5],
      ["Zeta", 10, 3]
    ]);
  });
});

describe("one rule for which store a centre uses", () => {
  it("is the catalogue when the clinic has a non-product row, and nothing else", async () => {
    expect(await usesCatalogue(db, programme.id)).toBe(true);
    expect(await usesCatalogue(db, plain.id)).toBe(false);

    // Retail products alone do not make the scan screen read the catalogue.
    await db.catalogItem.create({
      data: { clinicId: plain.id, externalId: "p", name: "Crema", priceCents: 900, isProduct: true }
    });
    expect(await usesCatalogue(db, plain.id)).toBe(false);
  });

  it("writes the catalogue mid-onboarding, with rows and no live programme, and the scan screen shows it", async () => {
    await db.catalogItem.create({
      data: { clinicId: onboarding.id, externalId: "x", name: "Importado", priceCents: 5000 }
    });

    const row = await createTreatment(db, onboarding.id, {
      name: "Nuevo",
      priceEuro: 25,
      categoryId: "MAS"
    });

    expect(await db.catalogItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      clinicId: onboarding.id,
      priceCents: 2500,
      needsReview: false
    });
    expect(await db.clinicTreatment.count({ where: { clinicId: onboarding.id } })).toBe(0);
    expect((await scanScreenTreatments(db, onboarding.id)).map((t) => t.name)).toEqual([
      "Importado",
      "Nuevo"
    ]);

    await updateTreatment(db, onboarding.id, row.id, { priceEuro: 30 });
    await removeTreatment(db, onboarding.id, row.id);
    expect((await scanScreenTreatments(db, onboarding.id)).map((t) => t.name)).toEqual([
      "Importado"
    ]);
  });

  it("writes ClinicTreatment at a plain centre and the scan screen shows it", async () => {
    const row = await createTreatment(db, plain.id, { name: "Masaje", priceEuro: 60 });

    expect(await db.clinicTreatment.count({ where: { clinicId: plain.id } })).toBe(1);
    expect(await scanScreenTreatments(db, plain.id)).toEqual([
      { id: row.id, name: "Masaje", priceEuro: 60, points: 600 }
    ]);
  });

  it("decides a live programme with an empty catalogue by the same rule: ClinicTreatment", async () => {
    await activeProgramme(emptyProgramme.id);

    const row = await createTreatment(db, emptyProgramme.id, { name: "Peeling", priceEuro: 40 });

    expect(await db.clinicTreatment.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      clinicId: emptyProgramme.id
    });
    expect(await db.catalogItem.count({ where: { clinicId: emptyProgramme.id } })).toBe(0);
    expect((await scanScreenTreatments(db, emptyProgramme.id)).map((t) => t.id)).toEqual([row.id]);
  });

  it("scan screen output keeps whole euros", async () => {
    await db.catalogItem.deleteMany({ where: { clinicId: programme.id } });
    await db.catalogItem.create({
      data: { clinicId: programme.id, externalId: "h", name: "Medio", priceCents: 1250 }
    });

    expect(await scanScreenTreatments(db, programme.id)).toEqual([
      expect.objectContaining({ name: "Medio", priceEuro: 13, points: 125 })
    ]);
  });
});

describe("treatment categories", () => {
  it("labels every category the engine accepts, so a new one cannot ship unlabelled", () => {
    const categories = treatmentCategories();

    expect(categories.map((c) => c.id).sort()).toEqual(Object.keys(CATEGORIES).sort());
    for (const category of categories) {
      expect(category.label.trim().length).toBeGreaterThan(0);
    }
    expect(categories.find((c) => c.id === "FAC")).toEqual({
      id: "FAC",
      label: "Facial de cabina"
    });
  });
});
