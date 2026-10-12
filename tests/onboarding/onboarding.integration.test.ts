import { OnboardingProgramStatus, PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PrismaCatalogRepository,
  toEngineCatalog,
  type CatalogInput
} from "../../src/modules/onboarding/catalog.repository";
import { run } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { isEngineError } from "../../src/modules/onboarding/engine.types";
import {
  OnboardingError,
  OnboardingService
} from "../../src/modules/onboarding/onboarding.service";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * The storage layer, against a real database.
 *
 * The question these answer is not "does Prisma work" but "does storing a catalogue
 * change the programme". The engine leans on item ids and euro prices for every
 * tie-break, and this layer converts both — so a mistake here does not throw, it quietly
 * produces a different reward ladder.
 */
const db = new PrismaClient();
const repo = new PrismaCatalogRepository(db);
const service = new OnboardingService(db, repo);

const SLUG = "test-onb";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const fixture = catalogFixture as CatalogItem[];

/** The fixture, as the catalogue API would receive it. */
const asInput = (items: CatalogItem[]): CatalogInput[] =>
  items.map((i) => ({
    externalId: i.id,
    name: i.name,
    priceEuro: i.price,
    isProduct: i.product ?? false,
    costPctOverride: i.costPct ?? null,
    estimated: i.estimated ?? false
  }));

let clinic: Clinic;

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro de prueba", addressLine: "Calle Uno 1", pincode: "28001" }
  });
});

beforeEach(async () => {
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
});

afterAll(async () => {
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("a catalogue that has been through the database", () => {
  it("produces the IDENTICAL programme to the raw fixture", async () => {
    // The point of the whole storage layer. Prices become cents and back; ids come from
    // externalId rather than the row's uuid; order comes from `position`. If any of that
    // drifts, the ladder changes without anything failing.
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const stored = toEngineCatalog(await repo.listForClinic(clinic.id));
    const fromStorage = run(stored, ANSWERS);
    const fromFixture = run(fixture, ANSWERS);

    expect(isEngineError(fromStorage)).toBe(false);

    const ladder = (p: unknown) => (p as Program).chosen.map((c) => c.o.items.map((i) => i.id));

    expect(ladder(fromStorage)).toEqual(ladder(fromFixture));
    expect((fromStorage as Program).est).toEqual((fromFixture as Program).est);
    expect((fromStorage as Program).lad.ms.map((m) => m.th)).toEqual(
      (fromFixture as Program).lad.ms.map((m) => m.th)
    );
  });

  it("keeps a row's identity when the catalogue is re-uploaded", async () => {
    // The reason this is not ClinicTreatment. That table deletes and recreates on every
    // save, minting new uuids — which would change the engine's tie-breaks, and so the
    // ladder, after an edit that touched nothing relevant.
    const first = await repo.replaceForClinic(clinic.id, asInput(fixture));
    const idsBefore = new Map(first.map((r) => [r.externalId, r.id]));

    const edited = asInput(fixture);
    edited[0].priceEuro = edited[0].priceEuro + 5;

    const second = await repo.replaceForClinic(clinic.id, edited);

    for (const row of second) {
      expect(row.id, `row ${row.externalId} was recreated`).toBe(idsBefore.get(row.externalId));
    }
  });

  it("drops rows the new catalogue leaves out", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));
    const trimmed = asInput(fixture).slice(0, 10);

    const after = await repo.replaceForClinic(clinic.id, trimmed);

    expect(after).toHaveLength(10);
  });

  it("returns rows in a stable order however they were written", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const a = (await repo.listForClinic(clinic.id)).map((r) => r.externalId);
    const b = (await repo.listForClinic(clinic.id)).map((r) => r.externalId);

    expect(a).toEqual(b);
    expect(a).toEqual(fixture.map((i) => i.id));
  });

  it("round-trips a price with cents exactly", async () => {
    await repo.replaceForClinic(clinic.id, [
      { externalId: "P1", name: "Ampolla", priceEuro: 12.5 }
    ]);

    const [row] = await repo.listForClinic(clinic.id);

    expect(row.priceCents).toBe(1250);
    expect(toEngineCatalog([row])[0].price).toBe(12.5);
  });

  it("records a category the centre chose and clears the review flag", async () => {
    await repo.replaceForClinic(clinic.id, [
      { externalId: "X1", name: "Servicio sin nombre reconocible", priceEuro: 40 }
    ]);

    const updated = await repo.updateItem(clinic.id, "X1", { categoryId: "FAC" });

    expect(updated?.categoryId).toBe("FAC");
    expect(updated?.classificationSource).toBe("centro");
    expect(updated?.needsReview).toBe(false);
    // And the engine honours it over its own keyword guess.
    expect(toEngineCatalog([updated!])[0].cat).toBe("FAC");
  });

  it("ignores a category the engine does not know", async () => {
    await repo.replaceForClinic(clinic.id, [{ externalId: "X2", name: "Algo", priceEuro: 30 }]);
    await repo.updateItem(clinic.id, "X2", { categoryId: "NOPE" });

    const [row] = await repo.listForClinic(clinic.id);

    // Stored as given, but not handed to the engine as a category it cannot interpret.
    expect(toEngineCatalog([row])[0].cat).toBeUndefined();
  });

  it("reports a missing row rather than throwing", async () => {
    expect(await repo.updateItem(clinic.id, "does-not-exist", { priceEuro: 10 })).toBeNull();
  });
});

describe("generating and publishing a programme", () => {
  it("refuses to estimate without a catalogue", async () => {
    await expect(service.estimatesFor(clinic.id)).rejects.toBeInstanceOf(OnboardingError);
  });

  it("offers the pre-selected buckets the questions screen needs", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const est = await service.estimatesFor(clinic.id);

    expect(est.segment).toBe("high");
    expect(est.ticketEstimate).toBe(65);
    expect(est.visitsEstimate).toBe(5.1);
    expect(est.ticketBuckets).toHaveLength(4);
    expect(est.freqBuckets).toHaveLength(5);
    expect(est.unclassified).toEqual([]);
  });

  it("numbers drafts from one, upwards", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const first = await service.createDraft(clinic.id, ANSWERS);
    const second = await service.createDraft(clinic.id, { ...ANSWERS, investment: "generoso" });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.status).toBe(OnboardingProgramStatus.BORRADOR);
  });

  it("stores the catalogue it used, so the programme can be regenerated", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const draft = await service.createDraft(clinic.id, ANSWERS);
    const snapshot = draft.catalogSnapshot as unknown as CatalogItem[];

    // Not a reference to the live catalogue: re-running the snapshot must give the same
    // ladder even after the centre edits its prices.
    expect(snapshot).toHaveLength(fixture.length);

    await repo.replaceForClinic(clinic.id, [
      { externalId: "ONLY", name: "Un solo tratamiento", priceEuro: 99 }
    ]);

    const replayed = run(snapshot, draft.answers as unknown as Answers);
    const original = draft.output as unknown as Program;

    expect(isEngineError(replayed)).toBe(false);
    expect((replayed as Program).chosen.map((c) => c.o.value)).toEqual(
      original.chosen.map((c) => c.o.value)
    );
  });

  it("records both version strings, because the same code with new numbers differs", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const draft = await service.createDraft(clinic.id, ANSWERS);

    expect(draft.engineVersion).toBe("1.2.0");
    expect(draft.configVersion).toBe("2026-10-07.1");
  });

  it("passes the engine's own refusal through to the centre", async () => {
    await repo.replaceForClinic(clinic.id, [
      { externalId: "M1", name: "Toxina botulínica", priceEuro: 300 }
    ]);

    await expect(service.createDraft(clinic.id, ANSWERS)).rejects.toThrow(
      /tratamientos con precio/
    );
  });

  it("publishes a clean draft and retires what was live", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const first = await service.createDraft(clinic.id, ANSWERS);
    const live = await service.publish(clinic.id, first.id);

    expect(live.status).toBe(OnboardingProgramStatus.ACTIVO);
    expect(live.publishedAt).not.toBeNull();

    const second = await service.createDraft(clinic.id, { ...ANSWERS, investment: "generoso" });
    await service.publish(clinic.id, second.id);

    const previous = await db.onboardingProgram.findUniqueOrThrow({ where: { id: first.id } });

    // Superseded, never deleted: members progressed against its thresholds.
    expect(previous.status).toBe(OnboardingProgramStatus.SUSTITUIDO);
    expect((await service.active(clinic.id))?.id).toBe(second.id);
  });

  it("refuses to publish a programme that still has review notes", async () => {
    // An unclassified row is exactly the case: Voone has already judged the programme
    // wrong, so putting it in front of members would be publishing a known defect.
    await repo.replaceForClinic(clinic.id, [
      ...asInput(fixture),
      { externalId: "X9", name: "Servicio sin nombre reconocible", priceEuro: 40 }
    ]);

    const draft = await service.createDraft(clinic.id, ANSWERS);
    const output = draft.output as unknown as Program;

    expect(output.review.length).toBeGreaterThan(0);
    await expect(service.publish(clinic.id, draft.id)).rejects.toThrow(/avisos que resolver/);

    const unchanged = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draft.id } });
    expect(unchanged.status).toBe(OnboardingProgramStatus.BORRADOR);
  });

  it("treats publishing an already live programme as a no-op", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const draft = await service.createDraft(clinic.id, ANSWERS);
    await service.publish(clinic.id, draft.id);

    // A double-tap in the dashboard must not retire the programme it just published.
    const again = await service.publish(clinic.id, draft.id);

    expect(again.status).toBe(OnboardingProgramStatus.ACTIVO);
  });

  it("refuses to republish a superseded version", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));

    const first = await service.createDraft(clinic.id, ANSWERS);
    await service.publish(clinic.id, first.id);
    const second = await service.createDraft(clinic.id, { ...ANSWERS, investment: "generoso" });
    await service.publish(clinic.id, second.id);

    await expect(service.publish(clinic.id, first.id)).rejects.toThrow(/sustituido/);
  });

  it("will not publish another clinic's programme", async () => {
    await repo.replaceForClinic(clinic.id, asInput(fixture));
    const draft = await service.createDraft(clinic.id, ANSWERS);

    await expect(service.publish("some-other-clinic", draft.id)).rejects.toThrow(/No existe/);
  });
});
