import { Prisma, TemplateStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  ClinicSlugTakenError,
  TemplatePresetNotFoundError
} from "../../src/common/errors/membership.errors";
import { provisionClinicSchema } from "../../src/modules/clinics/clinic-provisioning.schema";
import {
  provisionClinic,
  toProvisionedSummary
} from "../../src/modules/clinics/clinic-provisioning.service";

const PRESET = { id: "p1", name: "Classic Gold", hexBackgroundColor: "#ead0bd" };

const VALID = {
  slug: "clinica-nova",
  name: "Clínica Nova",
  addressLine: "Carrer de Balmes 12",
  pincode: "08007",
  presetId: "p1",
  programName: "Nova Beauty Club"
};

const db = (over: Record<string, unknown> = {}) => {
  const clinicCreate = vi.fn().mockResolvedValue({ id: "c1", slug: VALID.slug });
  const template = {
    id: "t1",
    clinicId: "c1",
    presetId: "p1",
    programName: VALID.programName,
    hexBackgroundColor: "#ead0bd",
    logoUrl: null,
    heroImageUrl: null,
    websiteUrl: null,
    appointmentUrl: null,
    appLinkText: null,
    appLinkDescription: null,
    pointsLabel: "Puntos",
    tierLabel: "Nivel",
    benefitsText: "x".repeat(10),
    infoText: "x".repeat(10),
    tierRewards: [],
    milestoneRewards: {
      milestoneCount: 10,
      pointsToNextMilestone: 2000,
      priceAmount: 10,
      pointsAwarded: 100
    },
    status: TemplateStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    clinic: { id: "c1", name: VALID.name },
    preset: PRESET,
    walletClasses: []
  };
  const templateCreate = vi.fn().mockResolvedValue(template);
  const treatmentDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const treatmentCreateMany = vi.fn().mockResolvedValue({ count: 1 });

  return {
    handle: {
      templatePreset: { findUnique: vi.fn().mockResolvedValue(PRESET) },
      // Runs the callback inline: the transaction is here for atomicity, not control flow.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        typeof fn === "function"
          ? fn({
              clinic: { create: clinicCreate },
              clinicTemplate: { create: templateCreate },
              clinicTreatment: { deleteMany: treatmentDeleteMany, createMany: treatmentCreateMany }
            })
          : fn
      ),
      walletClass: { upsert: vi.fn() },
      clinicTemplate: {
        update: vi.fn().mockResolvedValue({ ...template, status: TemplateStatus.FAILED }),
        findUnique: vi.fn().mockResolvedValue({ ...template, status: TemplateStatus.FAILED })
      },
      ...over
    },
    clinicCreate,
    templateCreate,
    treatmentDeleteMany,
    treatmentCreateMany
  };
};

describe("provisionClinicSchema", () => {
  it("fills the copy an operator does not have to hand", () => {
    const parsed = provisionClinicSchema.parse(VALID);

    expect(parsed.pointsLabel).toBe("Puntos");
    expect(parsed.tierLabel).toBe("Nivel");
    expect(parsed.benefitsText.length).toBeGreaterThan(8);
    expect(parsed.infoText.length).toBeGreaterThan(8);
    expect(parsed.tierRewards.map((tier) => tier.name)).toEqual([
      "Bronze",
      "Silver",
      "Gold",
      "Platinum",
      "Diamond"
    ]);
    expect(parsed.milestoneRewards).toEqual({
      milestoneCount: 10,
      pointsToNextMilestone: 2000,
      priceAmount: 10,
      pointsAwarded: 100
    });
  });

  it("accepts a colour when onboarding starts from an edited template", () => {
    const parsed = provisionClinicSchema.parse({ ...VALID, hexBackgroundColor: "#ff0000" });

    expect(parsed.hexBackgroundColor).toBe("#ff0000");
  });

  it("applies the same slug rules as the public URL", () => {
    for (const slug of ["Clinica-Nova", "clinica nova", "clinica/nova", "-nova", ""]) {
      expect(provisionClinicSchema.safeParse({ ...VALID, slug }).success, slug).toBe(false);
    }
  });

  it("rejects a clinic name longer than the pass can carry", () => {
    expect(provisionClinicSchema.safeParse({ ...VALID, name: "á".repeat(49) }).success).toBe(false);
  });
});

describe("provisionClinic", () => {
  it("creates the clinic and its template in one transaction", async () => {
    const { handle, clinicCreate, templateCreate } = db();

    await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    expect(handle.$transaction).toHaveBeenCalledOnce();
    expect(clinicCreate).toHaveBeenCalledOnce();
    expect(templateCreate).toHaveBeenCalledOnce();
  });

  it("takes the colour from the preset, not the request", async () => {
    const { handle, templateCreate } = db();

    await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    expect(templateCreate.mock.calls[0][0].data.hexBackgroundColor).toBe("#ead0bd");
  });

  it("persists edited template details during onboarding", async () => {
    const { handle, templateCreate, treatmentCreateMany } = db();

    await provisionClinic(
      handle as never,
      provisionClinicSchema.parse({
        ...VALID,
        hexBackgroundColor: "#101820",
        logoUrl: "https://example.com/logo.png",
        websiteUrl: "https://example.com",
        benefitsText: "Priority booking and birthday rewards.",
        infoText: "Show this pass before payment.",
        tierRewards: [
          { name: "Bronze", rewardText: "Welcome reward" },
          { name: "Gold", rewardText: "Priority booking" }
        ],
        milestoneRewards: {
          milestoneCount: 10,
          pointsToNextMilestone: 2000,
          priceAmount: 10,
          pointsAwarded: 100
        },
        treatments: [{ name: "Laser", priceEuro: 220, pointsAllotted: 2200 }]
      })
    );

    expect(templateCreate.mock.calls[0][0].data).toMatchObject({
      hexBackgroundColor: "#101820",
      logoUrl: "https://example.com/logo.png",
      websiteUrl: "https://example.com",
      benefitsText: "Priority booking and birthday rewards.",
      infoText: "Show this pass before payment.",
      tierRewards: [
        { name: "Bronze", rewardText: "Welcome reward" },
        { name: "Gold", rewardText: "Priority booking" }
      ],
      milestoneRewards: {
        milestoneCount: 10,
        pointsToNextMilestone: 2000,
        priceAmount: 10,
        pointsAwarded: 100
      }
    });
    expect(treatmentCreateMany.mock.calls[0][0].data).toEqual([
      { clinicId: "c1", name: "Laser", priceEuro: 220, pointsAllotted: 2200 }
    ]);
  });

  it("refuses an unknown preset before writing anything", async () => {
    const { handle } = db({ templatePreset: { findUnique: vi.fn().mockResolvedValue(null) } });

    await expect(
      provisionClinic(handle as never, provisionClinicSchema.parse(VALID))
    ).rejects.toThrow(TemplatePresetNotFoundError);
    expect(handle.$transaction).not.toHaveBeenCalled();
  });

  it("reports a taken slug as a conflict, not a 500", async () => {
    // Two operators can submit the same slug at once, so the unique index is what settles
    // it rather than a prior existence check.
    const { handle } = db({
      $transaction: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: Prisma.prismaVersion.client,
          meta: { target: ["slug"] }
        })
      )
    });

    const attempt = provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    await expect(attempt).rejects.toThrow(ClinicSlugTakenError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409, expose: true });
  });

  it("does not disguise an unrelated database failure as a slug conflict", async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("Cannot reach database", {
      code: "P1001",
      clientVersion: Prisma.prismaVersion.client
    });
    const { handle } = db({ $transaction: vi.fn().mockRejectedValue(outage) });

    await expect(provisionClinic(handle as never, provisionClinicSchema.parse(VALID))).rejects.toBe(
      outage
    );
  });
});

describe("toProvisionedSummary", () => {
  it("returns the slug the operator has to print, and nothing internal", () => {
    const summary = toProvisionedSummary({
      clinic: {
        id: "c1",
        slug: "clinica-nova",
        name: "Clínica Nova",
        addressLine: "Carrer de Balmes 12",
        pincode: "08007",
        isActive: true,
        privacyPolicyVersion: "v1",
        voonePlan: "starter",
        notificationsMonthlyQuota: 8,
        notificationsUsedThisMonth: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      template: {
        id: "t1",
        clinicId: "c1",
        presetId: "p1",
        programName: "Nova Beauty Club",
        hexBackgroundColor: "#ead0bd",
        logoUrl: null,
        heroImageUrl: null,
        websiteUrl: null,
        appointmentUrl: null,
        appLinkText: null,
        appLinkDescription: null,
        pointsLabel: "Puntos",
        tierLabel: "Nivel",
        benefitsText: "x".repeat(10),
        infoText: "x".repeat(10),
        tierRewards: [],
        milestoneRewards: {
          milestoneCount: 10,
          pointsToNextMilestone: 2000,
          priceAmount: 10,
          pointsAwarded: 100
        },
        status: "PENDING",
        createdAt: new Date(),
        updatedAt: new Date(),
        clinic: {
          id: "c1",
          slug: "clinica-nova",
          name: "Clínica Nova",
          addressLine: "Carrer de Balmes 12",
          pincode: "08007",
          isActive: true,
          privacyPolicyVersion: "v1",
          voonePlan: "starter",
          notificationsMonthlyQuota: 8,
          notificationsUsedThisMonth: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        preset: { ...PRESET, previewImageUrl: null, createdAt: new Date() },
        walletClasses: []
      }
    });

    expect(summary.clinic.slug).toBe("clinica-nova");
    expect(summary.clinic).not.toHaveProperty("addressLine");
    expect(summary.clinic).not.toHaveProperty("pincode");
    expect(summary.template.status).toBe("PENDING");
  });
});
