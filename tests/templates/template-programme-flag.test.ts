import { OnboardingProgramStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The wallet engine and the refresh queue are not what this file is about, and a real
// engine would reach for Google and Apple. The database is real: the flag is a filter on
// OnboardingProgram.status, and only a real query proves the filter.
vi.mock("../../src/wallet/engine/wallet-pass.engine", () => ({
  WalletPassEngine: vi.fn(function WalletPassEngine() {
    return { createClassForTemplate: vi.fn(async () => []) };
  })
}));

vi.mock("../../src/modules/wallet-refresh/clinic-card-refresh", () => ({
  refreshClinicCards: vi.fn(async () => 0)
}));

const { templatesService } = await import("../../src/modules/templates/templates.service");
const { templatesRepository } = await import("../../src/modules/templates/templates.repository");

/** One file, one fixture set: the clinics here are this file's own and are removed after. */
const db = new PrismaClient();
const SLUGS = ["flag-none", "flag-active", "flag-draft", "flag-replaced"];

const programme = (clinicId: string, version: number, status: OnboardingProgramStatus) =>
  db.onboardingProgram.create({
    data: {
      clinicId,
      version,
      status,
      engineVersion: "test",
      configVersion: "test",
      answers: {},
      output: {},
      catalogSnapshot: {}
    }
  });

const templates: Record<string, { id: string; clinicId: string }> = {};

const clean = async () => {
  const clinics = await db.clinic.findMany({ where: { slug: { in: SLUGS } } });
  const ids = clinics.map((clinic) => clinic.id);

  await db.onboardingProgram.deleteMany({ where: { clinicId: { in: ids } } });
  await db.clinicTemplate.deleteMany({ where: { clinicId: { in: ids } } });
};

beforeAll(async () => {
  await clean();

  const preset =
    (await db.templatePreset.findFirst()) ??
    (await db.templatePreset.create({
      data: { name: "flag-test", hexBackgroundColor: "#ffffff" }
    }));

  for (const slug of SLUGS) {
    const clinic = await db.clinic.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug, addressLine: "Calle 1", pincode: "28001" }
    });
    const template = await db.clinicTemplate.create({
      data: {
        clinicId: clinic.id,
        presetId: preset.id,
        programName: slug,
        hexBackgroundColor: "#ffffff",
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: "Beneficios de prueba.",
        infoText: "Información de prueba."
      }
    });

    templates[slug] = { id: template.id, clinicId: clinic.id };
  }

  await programme(templates["flag-active"].clinicId, 1, OnboardingProgramStatus.SUSTITUIDO);
  await programme(templates["flag-active"].clinicId, 2, OnboardingProgramStatus.ACTIVO);
  await programme(templates["flag-draft"].clinicId, 1, OnboardingProgramStatus.BORRADOR);
  await programme(templates["flag-replaced"].clinicId, 1, OnboardingProgramStatus.SUSTITUIDO);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await clean();
  await db.clinic.deleteMany({ where: { slug: { in: SLUGS } } });
  await db.$disconnect();
});

const byId = (slug: string) =>
  templatesService.findOwnedById(templates[slug].id, templates[slug].clinicId);

describe("hasActiveProgramme on GET /templates/:templateId", () => {
  it("is true when the clinic has an ACTIVO programme, even beside a replaced one", async () => {
    expect(await byId("flag-active")).toMatchObject({ hasActiveProgramme: true });
  });

  it("is false when the only programme is a BORRADOR", async () => {
    expect(await byId("flag-draft")).toMatchObject({ hasActiveProgramme: false });
  });

  it("is false when the only programme is SUSTITUIDO", async () => {
    expect(await byId("flag-replaced")).toMatchObject({ hasActiveProgramme: false });
  });

  it("is false when the clinic has no programme at all", async () => {
    expect(await byId("flag-none")).toMatchObject({ hasActiveProgramme: false });
  });

  it("keeps the rest of the template payload intact", async () => {
    expect(await byId("flag-none")).toMatchObject({
      id: templates["flag-none"].id,
      benefitsText: "Beneficios de prueba.",
      clinic: { slug: "flag-none" }
    });
  });

  it("still refuses another clinic's template without asking about programmes", async () => {
    const spy = vi.spyOn(templatesRepository, "findClinicIdsWithActiveProgramme");

    await expect(
      templatesService.findOwnedById(templates["flag-active"].id, templates["flag-none"].clinicId)
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hasActiveProgramme on GET /templates/current", () => {
  it("carries the flag", async () => {
    expect(await templatesService.findByClinicId(templates["flag-active"].clinicId)).toMatchObject({
      hasActiveProgramme: true
    });
    expect(await templatesService.findByClinicId(templates["flag-draft"].clinicId)).toMatchObject({
      hasActiveProgramme: false
    });
  });

  it("stays null for a clinic with no template, and asks nothing", async () => {
    const spy = vi.spyOn(templatesRepository, "findClinicIdsWithActiveProgramme");

    expect(
      await templatesService.findByClinicId("00000000-0000-4000-8000-00000000dead")
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hasActiveProgramme on GET /templates (list)", () => {
  it("carries the flag and asks the programme table once, as a batch", async () => {
    const spy = vi.spyOn(templatesRepository, "findClinicIdsWithActiveProgramme");

    const list = await templatesService.listTemplates(templates["flag-active"].clinicId);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ hasActiveProgramme: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([templates["flag-active"].clinicId]);
  });

  it("is an empty list, with no programme query, for a clinic with no template", async () => {
    const spy = vi.spyOn(templatesRepository, "findClinicIdsWithActiveProgramme");

    expect(await templatesService.listTemplates("00000000-0000-4000-8000-00000000dead")).toEqual(
      []
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("templatesRepository.findClinicIdsWithActiveProgramme", () => {
  it("answers for many clinics in one call and returns only those with an ACTIVO programme", async () => {
    const ids = SLUGS.map((slug) => templates[slug].clinicId);

    const active = await templatesRepository.findClinicIdsWithActiveProgramme(ids);

    expect([...active]).toEqual([templates["flag-active"].clinicId]);
  });

  it("returns an empty set without querying for an empty list", async () => {
    expect((await templatesRepository.findClinicIdsWithActiveProgramme([])).size).toBe(0);
  });
});
