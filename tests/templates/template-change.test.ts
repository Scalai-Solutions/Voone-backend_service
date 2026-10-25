import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({ templateChange: { create: vi.fn() } }));

vi.mock("../../src/modules/templates/templates.repository", () => ({
  templatesRepository: {
    findById: vi.fn(),
    update: vi.fn(),
    markActive: vi.fn(),
    markFailed: vi.fn()
  },
  treatmentsRepository: { replaceForClinic: vi.fn() },
  vooneTemplatesRepository: {}
}));

vi.mock("../../src/infrastructure/database/prisma-client", () => ({
  prisma: {
    member: { count: vi.fn() },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx))
  }
}));

const walletPassEngine = { createClassForTemplate: vi.fn(async () => []) };

vi.mock("../../src/wallet/engine/wallet-pass.engine", () => ({
  WalletPassEngine: vi.fn(function WalletPassEngine() {
    return walletPassEngine;
  })
}));

vi.mock("../../src/modules/wallet-refresh/clinic-card-refresh", () => ({
  refreshClinicCards: vi.fn(async () => 0)
}));

vi.mock("../../src/common/logger/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() }
}));

const { prisma } = await import("../../src/infrastructure/database/prisma-client");
const { templatesRepository } = await import("../../src/modules/templates/templates.repository");
const { templatesService } = await import("../../src/modules/templates/templates.service");
const { diffTemplate, recordTemplateChange } =
  await import("../../src/modules/templates/template-change.service");

const FIELDS = {
  programName: "AURÉA Clinic Club",
  hexBackgroundColor: "#ead0bd",
  logoUrl: "https://cdn.example/logo.png",
  logoOnDarkUrl: null,
  heroImageUrl: null,
  websiteUrl: null,
  appointmentUrl: null,
  appLinkText: null,
  appLinkDescription: null,
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción."
};

const EXISTING = { id: "t1", clinicId: "c1", ...FIELDS };

const tierRewards = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"].map((name, index) => ({
  name,
  rewardText: "",
  minLifetimePoints: index * 1000,
  milestoneCount: 5,
  pointsToNextMilestone: 200
}));

const INPUT = {
  presetId: "p1",
  ...FIELDS,
  logoOnDarkUrl: undefined,
  heroImageUrl: undefined,
  websiteUrl: undefined,
  appointmentUrl: undefined,
  appLinkText: undefined,
  appLinkDescription: undefined,
  tierRewards,
  milestoneRewards: {
    milestoneCount: 10,
    pointsToNextMilestone: 2000,
    priceAmount: 10,
    pointsAwarded: 100
  }
};

beforeEach(() => {
  vi.mocked(templatesRepository.findById).mockReset();
  vi.mocked(templatesRepository.update).mockReset();
  tx.templateChange.create.mockReset();
  vi.mocked(prisma.member.count).mockReset();
  vi.mocked(templatesRepository.findById).mockResolvedValue(EXISTING as never);
  vi.mocked(templatesRepository.update).mockResolvedValue(EXISTING as never);
});

describe("diffTemplate", () => {
  it("names each field whose value changed", () => {
    expect(
      diffTemplate(FIELDS, {
        ...FIELDS,
        heroImageUrl: "https://cdn.example/h.png",
        tierLabel: "Rango"
      })
    ).toEqual(["heroImageUrl", "tierLabel"]);
  });

  it("reports nothing when nothing changed", () => {
    expect(diffTemplate(FIELDS, { ...FIELDS })).toEqual([]);
  });

  it("treats an empty or blank optional field as the same as null", () => {
    // The repository stores "" and "  " as null, so the form re-sending a cleared field
    // must not look like an edit.
    expect(
      diffTemplate(FIELDS, {
        ...FIELDS,
        websiteUrl: "",
        appLinkText: "   ",
        logoOnDarkUrl: undefined
      })
    ).toEqual([]);
  });

  it("sees a cleared optional field as a change", () => {
    expect(diffTemplate(FIELDS, { ...FIELDS, logoUrl: "" })).toEqual(["logoUrl"]);
  });
});

describe("recordTemplateChange", () => {
  it("stores the actor, or null when there is none", async () => {
    const create = vi.fn();
    const db = { templateChange: { create } } as never;

    await recordTemplateChange(db, {
      clinicId: "c1",
      templateId: "t1",
      actor: "owner@clinic.es",
      changedFields: ["heroImageUrl"],
      cardsAtSave: 3
    });
    await recordTemplateChange(db, {
      clinicId: "c1",
      templateId: "t1",
      changedFields: ["heroImageUrl"],
      cardsAtSave: 3
    });

    expect(create).toHaveBeenNthCalledWith(1, {
      data: {
        clinicId: "c1",
        templateId: "t1",
        changedBy: "owner@clinic.es",
        changedFields: ["heroImageUrl"],
        cardsAtSave: 3
      }
    });
    expect(create.mock.calls[1]?.[0].data.changedBy).toBeNull();
  });
});

describe("updateClinicTemplate change record", () => {
  it("writes one record for a new hero image, with the actor and the live card count", async () => {
    vi.mocked(prisma.member.count).mockResolvedValue(42);

    await templatesService.updateClinicTemplate(
      "t1",
      "c1",
      { ...INPUT, heroImageUrl: "https://cdn.example/hero.png" },
      "owner@clinic.es"
    );

    expect(prisma.member.count).toHaveBeenCalledWith({
      where: { clinicId: "c1", erasedAt: null, walletObjects: { some: {} } }
    });
    expect(tx.templateChange.create).toHaveBeenCalledTimes(1);
    expect(tx.templateChange.create).toHaveBeenCalledWith({
      data: {
        clinicId: "c1",
        templateId: "t1",
        changedBy: "owner@clinic.es",
        changedFields: ["heroImageUrl"],
        cardsAtSave: 42
      }
    });
  });

  it("writes none when the saved values are identical", async () => {
    await templatesService.updateClinicTemplate("t1", "c1", INPUT, "owner@clinic.es");

    expect(tx.templateChange.create).not.toHaveBeenCalled();
    expect(templatesRepository.update).toHaveBeenCalledTimes(1);
  });

  it("stores a null actor when the request named nobody", async () => {
    vi.mocked(prisma.member.count).mockResolvedValue(0);

    await templatesService.updateClinicTemplate("t1", "c1", { ...INPUT, tierLabel: "Rango" });

    expect(tx.templateChange.create.mock.calls[0]?.[0].data.changedBy).toBeNull();
  });
});
