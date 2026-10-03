import { Prisma, TemplateStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  slug: "nova7",
  name: "Clínica Nova",
  addressLine: "Carrer de Balmes 12",
  pincode: "08007",
  presetId: "p1",
  programName: "Nova Beauty Club"
};

const GOOGLE_WALLET_ENV_KEYS = [
  "GOOGLE_WALLET_ISSUER_ID",
  "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
  "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WALLET_ALLOWED_ORIGIN"
] as const;

const originalGoogleWalletEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of GOOGLE_WALLET_ENV_KEYS) {
    originalGoogleWalletEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of GOOGLE_WALLET_ENV_KEYS) {
    const value = originalGoogleWalletEnv.get(key);

    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  originalGoogleWalletEnv.clear();
});

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
  const clinicFindUnique = vi.fn().mockResolvedValue(null);

  return {
    handle: {
      clinic: { findUnique: clinicFindUnique },
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
      walletClass: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      clinicTemplate: {
        update: vi.fn().mockResolvedValue({ ...template, status: TemplateStatus.FAILED }),
        findUnique: vi.fn().mockResolvedValue({ ...template, status: TemplateStatus.FAILED })
      },
      ...over
    },
    clinicCreate,
    templateCreate,
    treatmentDeleteMany,
    treatmentCreateMany,
    clinicFindUnique
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

  it("takes exactly five characters, and nothing else", () => {
    // Deliberately STRICTER than the slug rules for an incoming URL. A slug is printed on
    // a QR poster and typed off it by hand, so the length is the feature; the clinics
    // provisioned before this cap still have long slugs on posters in their waiting
    // rooms, which is why clinicSlugSchema stays permissive — see its own test.
    for (const slug of ["nova", "nova77", "Nova7", "nov a", "nov/a", "no-va", "clinica-nova", ""]) {
      expect(provisionClinicSchema.safeParse({ ...VALID, slug }).success, slug).toBe(false);
    }

    expect(provisionClinicSchema.safeParse({ ...VALID, slug: "nova7" }).success).toBe(true);
    expect(provisionClinicSchema.safeParse({ ...VALID, slug: "77777" }).success).toBe(true);
  });

  it("accepts no slug at all, because one gets generated", () => {
    // What the onboarding wizard sends by default. At five characters there is no slug
    // derivable from a clinic's name that stays distinct, so nobody is asked to invent
    // one on an onboarding call.
    const { slug, ...withoutSlug } = VALID;
    const parsed = provisionClinicSchema.safeParse(withoutSlug);

    expect(slug).toBeDefined();
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.slug).toBeUndefined();
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
          { name: "Bronze", rewardText: "Welcome reward", minLifetimePoints: 0 },
          { name: "Gold", rewardText: "Priority booking", minLifetimePoints: 3000 }
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
        // Defaults fill in the milestone rhythm; the floors are what the clinic chose.
        { name: "Bronze", rewardText: "Welcome reward", minLifetimePoints: 0 },
        { name: "Gold", rewardText: "Priority booking", minLifetimePoints: 3000 }
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

  it("generates a slug when the operator did not choose one", async () => {
    const { handle, clinicCreate } = db();
    const { slug, ...withoutSlug } = VALID;

    await provisionClinic(handle as never, provisionClinicSchema.parse(withoutSlug));

    expect(slug).toBeDefined();
    expect(clinicCreate.mock.calls[0][0].data.slug).toMatch(/^[a-z0-9]{5}$/);
  });

  it("picks another slug when a GENERATED one is already taken", async () => {
    // A collision the operator did not cause and cannot resolve: one in 28.6 million,
    // and asking someone on an onboarding call to pick again would be absurd.
    const taken = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { target: ["slug"] }
    });
    const { handle, clinicCreate } = db();

    clinicCreate.mockRejectedValueOnce(taken);

    const { slug, ...withoutSlug } = VALID;
    await provisionClinic(handle as never, provisionClinicSchema.parse(withoutSlug));

    expect(slug).toBeDefined();
    expect(clinicCreate).toHaveBeenCalledTimes(2);
    // A fresh slug, not the same one retried — which would collide forever.
    expect(clinicCreate.mock.calls[1][0].data.slug).not.toBe(
      clinicCreate.mock.calls[0][0].data.slug
    );
  });

  it("does not quietly re-slug a clinic whose slug the operator TYPED", async () => {
    // The other half of the rule above. A typed slug is a decision, so a collision is
    // the operator's to resolve: silently giving the clinic a different one would mean
    // the poster they are about to print says something else.
    const taken = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { target: ["slug"] }
    });
    const { handle, clinicCreate } = db();

    clinicCreate.mockRejectedValueOnce(taken);

    await expect(
      provisionClinic(handle as never, provisionClinicSchema.parse(VALID))
    ).rejects.toThrow(ClinicSlugTakenError);
    expect(clinicCreate).toHaveBeenCalledOnce();
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
