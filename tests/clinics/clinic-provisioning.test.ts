import { Prisma, TemplateStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClinicCardCreationError,
  ClinicSlugTakenError,
  TemplatePresetNotFoundError
} from "../../src/common/errors/membership.errors";
import { provisionClinicSchema } from "../../src/modules/clinics/clinic-provisioning.schema";
import {
  provisionClinic,
  toProvisionedSummary
} from "../../src/modules/clinics/clinic-provisioning.service";

// The engine is replaced so each test chooses what Google does. The default is "no provider
// produced a class", which is what the real engine returns with no Google env configured.
const walletEngine = vi.hoisted(() => ({ createClassForTemplate: vi.fn() }));

vi.mock("../../src/wallet/engine/wallet-pass.engine", () => ({
  WalletPassEngine: vi.fn(function WalletPassEngine() {
    return walletEngine;
  })
}));

vi.mock("../../src/common/logger/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}));

const { GoogleWalletApiError } = await import("../../src/wallet/providers/google/client");

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
  walletEngine.createClassForTemplate.mockReset();
  walletEngine.createClassForTemplate.mockResolvedValue([]);

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
    logoOnDarkUrl: null,
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
  const rollback = {
    walletClassDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    templateDeleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    treatmentDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    clinicDelete: vi.fn().mockResolvedValue({ id: "c1" }),
    userFindUnique: vi.fn().mockResolvedValue(null),
    userUpsert: vi.fn().mockResolvedValue({ id: "u1" }),
    userUpdate: vi.fn().mockResolvedValue({ id: "u1" }),
    userDeleteMany: vi.fn().mockResolvedValue({ count: 1 })
  };

  return {
    handle: {
      clinic: { findUnique: clinicFindUnique },
      templatePreset: { findUnique: vi.fn().mockResolvedValue(PRESET) },
      // Runs the callback inline: the transaction is here for atomicity, not control flow.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        typeof fn === "function"
          ? fn({
              clinic: { create: clinicCreate, delete: rollback.clinicDelete },
              clinicTemplate: { create: templateCreate, deleteMany: rollback.templateDeleteMany },
              clinicTreatment: {
                deleteMany: (...args: unknown[]) => {
                  treatmentDeleteMany(...args);
                  return rollback.treatmentDeleteMany(...args);
                },
                createMany: treatmentCreateMany
              },
              walletClass: { deleteMany: rollback.walletClassDeleteMany },
              user: {
                findUnique: rollback.userFindUnique,
                upsert: rollback.userUpsert,
                update: rollback.userUpdate,
                deleteMany: rollback.userDeleteMany
              }
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
    clinicFindUnique,
    rollback
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

  it("creates the centre as an inactive draft until it is activated (founders' E2E 15-17)", async () => {
    const { handle, clinicCreate } = db();

    await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

    expect(clinicCreate.mock.calls[0][0].data.isActive).toBe(false);
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

  describe("when the wallet step fails", () => {
    const googleRejected = () =>
      new GoogleWalletApiError("Invalid class", 400, "Bad Request", { error: "bad logo" });

    it("keeps the clinic and its PENDING template when Google rejects the card", async () => {
      const { handle, rollback } = db();

      walletEngine.createClassForTemplate.mockRejectedValue(googleRejected());
      // What the row holds after creation: nothing in this path writes another status.
      handle.clinicTemplate.findUnique.mockResolvedValue({
        id: "t1",
        status: TemplateStatus.PENDING
      });

      const result = await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

      expect(result.clinic.id).toBe("c1");
      expect(result.template.status).toBe(TemplateStatus.PENDING);
      expect(result.walletWarning).toBe("google_pending");
      expect(handle.clinicTemplate.update).not.toHaveBeenCalled();
      expect(rollback.clinicDelete).not.toHaveBeenCalled();
      expect(rollback.templateDeleteMany).not.toHaveBeenCalled();
    });

    it("does not warn when nothing failed", async () => {
      const { handle } = db();

      const result = await provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

      expect(result.walletWarning).toBeUndefined();
    });

    it("deletes what this call created and says so, for any OTHER wallet error", async () => {
      const { handle, rollback } = db();

      walletEngine.createClassForTemplate.mockRejectedValue(new Error("signing key unreadable"));

      const attempt = provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

      await expect(attempt).rejects.toThrow(ClinicCardCreationError);
      await expect(attempt).rejects.toMatchObject({
        statusCode: 502,
        expose: true,
        message:
          "No se ha podido crear la tarjeta del centro. No se ha guardado nada; inténtalo de nuevo."
      });
      // The schema has no cascade from Clinic, so each dependent row goes explicitly,
      // children first.
      expect(rollback.walletClassDeleteMany).toHaveBeenCalledWith({
        where: { clinicTemplateId: "t1" }
      });
      expect(rollback.templateDeleteMany).toHaveBeenCalledWith({ where: { id: "t1" } });
      expect(rollback.treatmentDeleteMany).toHaveBeenCalledWith({ where: { clinicId: "c1" } });
      expect(rollback.clinicDelete).toHaveBeenCalledWith({ where: { id: "c1" } });
      expect(handle.clinicTemplate.update).not.toHaveBeenCalled();
    });

    it("removes an owner account this call created", async () => {
      const { handle, rollback } = db();

      rollback.userFindUnique.mockResolvedValue(null);
      walletEngine.createClassForTemplate.mockRejectedValue(new Error("boom"));

      await expect(
        provisionClinic(
          handle as never,
          provisionClinicSchema.parse({ ...VALID, ownerEmail: "owner@nova.es" })
        )
      ).rejects.toThrow(ClinicCardCreationError);

      // Scoped to THIS call's clinic: Google can take seconds, and a second onboarding with
      // the same owner email may meanwhile have moved the user onto its own clinic. That
      // row no longer matches the filter, so it is not deleted.
      expect(rollback.userDeleteMany).toHaveBeenCalledWith({
        where: { email: "owner@nova.es", clinicId: "c1" }
      });
      expect(rollback.userUpdate).not.toHaveBeenCalled();
    });

    it("puts an existing owner back where it was instead of deleting the account", async () => {
      const { handle, rollback } = db();

      rollback.userFindUnique.mockResolvedValue({
        id: "u1",
        clinicId: "old-clinic",
        name: "Ana",
        role: "OWNER"
      });
      walletEngine.createClassForTemplate.mockRejectedValue(new Error("boom"));

      await expect(
        provisionClinic(
          handle as never,
          provisionClinicSchema.parse({ ...VALID, ownerEmail: "owner@nova.es" })
        )
      ).rejects.toThrow(ClinicCardCreationError);

      expect(rollback.userUpdate).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { clinicId: "old-clinic", name: "Ana", role: "OWNER" }
      });
      expect(rollback.userDeleteMany).not.toHaveBeenCalled();
    });

    it("does not claim 'nothing was saved' when the clean-up itself fails", async () => {
      const { handle } = db();
      let transactions = 0;
      const inner = handle.$transaction;

      handle.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => {
        transactions += 1;
        // First call creates the clinic; the second is the clean-up.
        if (transactions === 2) throw new Error("database went away");
        return inner(fn);
      }) as never;
      walletEngine.createClassForTemplate.mockRejectedValue(new Error("boom"));

      const attempt = provisionClinic(handle as never, provisionClinicSchema.parse(VALID));

      await expect(attempt).rejects.toThrow(ClinicCardCreationError);
      await expect(attempt).rejects.toMatchObject({
        statusCode: 502,
        message: expect.not.stringContaining("No se ha guardado nada")
      });
    });
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
        logoOnDarkUrl: null,
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

  it("carries the Google warning, with the message the operator reads", () => {
    const base = {
      clinic: { id: "c1", slug: "nova7", name: "N", isActive: false, privacyPolicyVersion: null },
      template: { id: "t1", programName: "P", hexBackgroundColor: "#fff", status: "PENDING" }
    };

    const warned = toProvisionedSummary({ ...base, walletWarning: "google_pending" } as never);
    const clean = toProvisionedSummary(base as never);

    expect(warned.walletWarning).toBe("google_pending");
    expect(warned.walletWarningMessage).toBe(
      "La tarjeta de Google no se ha podido crear todavía. Se reintentará al guardar el diseño de la tarjeta."
    );
    expect(clean).not.toHaveProperty("walletWarning");
    expect(clean).not.toHaveProperty("walletWarningMessage");
  });
});
