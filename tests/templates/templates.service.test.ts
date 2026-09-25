import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked because the service reaches for these directly rather than taking them as
// arguments. The behaviour worth pinning is what it does when a wallet class cannot be
// created — a template must never be left claiming ACTIVE when nothing was provisioned.
vi.mock("../../src/modules/templates/templates.repository", () => ({
  templatesRepository: {
    findPresets: vi.fn(),
    findByClinicId: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    markActive: vi.fn(),
    markFailed: vi.fn()
  },
  treatmentsRepository: { replaceForClinic: vi.fn() }
}));

vi.mock("../../src/infrastructure/database/prisma-client", () => ({
  // Runs the callback inline: the transaction's job here is atomicity, not control flow.
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) }
}));

vi.mock("../../src/wallet/engine/wallet-pass.engine", () => ({
  walletPassEngine: { createClassForTemplate: vi.fn() }
}));

vi.mock("../../src/common/logger/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() }
}));

const { templatesRepository, treatmentsRepository } =
  await import("../../src/modules/templates/templates.repository");
const { walletPassEngine } = await import("../../src/wallet/engine/wallet-pass.engine");
const { templatesService } = await import("../../src/modules/templates/templates.service");
const { ConflictError } = await import("../../src/common/errors/conflict-error");

const TEMPLATE = { id: "t1", clinicId: "c1" };

const INPUT = {
  presetId: "p1",
  programName: "AURÉA Clinic Club",
  hexBackgroundColor: "#ead0bd",
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción.",
  tierRewards: [
    { name: "Bronze", rewardText: "" },
    { name: "Silver", rewardText: "" },
    { name: "Gold", rewardText: "" },
    { name: "Platinum", rewardText: "" },
    { name: "Diamond", rewardText: "" }
  ],
  milestoneRewards: {
    milestoneCount: 10,
    pointsToNextMilestone: 2000,
    priceAmount: 10,
    pointsAwarded: 100
  },
  treatments: [{ name: "Limpieza facial", priceEuro: 50, pointsAllotted: 500 }]
};

const asMock = <T>(value: T) => value as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(templatesRepository.findByClinicId).mockReset();
  vi.mocked(templatesRepository.findById).mockReset();
  vi.mocked(templatesRepository.create).mockReset();
  vi.mocked(templatesRepository.update).mockReset();
  vi.mocked(templatesRepository.markActive).mockReset();
  vi.mocked(templatesRepository.markFailed).mockReset();
  vi.mocked(treatmentsRepository.replaceForClinic).mockReset();
  vi.mocked(walletPassEngine.createClassForTemplate).mockReset();
});

describe("createClinicTemplate", () => {
  it("refuses a second template, since a clinic is allowed exactly one", () => {
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(TEMPLATE as never);

    return expect(templatesService.createClinicTemplate("c1", INPUT)).rejects.toThrow(
      ConflictError
    );
  });

  it("converts a lost race on the unique clinic into the same conflict", async () => {
    // Two requests can both read "no template" and both insert; the index is what
    // actually settles it, and the loser must see a conflict rather than a 500.
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);
    vi.mocked(templatesRepository.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: Prisma.prismaVersion.client,
        meta: { target: ["clinicId"] }
      })
    );

    await expect(templatesService.createClinicTemplate("c1", INPUT)).rejects.toThrow(ConflictError);
  });

  it("does not swallow an unrelated database failure as a conflict", async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("Cannot reach database", {
      code: "P1001",
      clientVersion: Prisma.prismaVersion.client
    });
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);
    vi.mocked(templatesRepository.create).mockRejectedValue(outage);

    await expect(templatesService.createClinicTemplate("c1", INPUT)).rejects.toBe(outage);
  });

  it("marks the template active once a wallet class exists", async () => {
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);
    vi.mocked(templatesRepository.create).mockResolvedValue(TEMPLATE as never);
    vi.mocked(walletPassEngine.createClassForTemplate).mockResolvedValue([
      { provider: "GOOGLE", externalClassId: "x" }
    ] as never);

    await templatesService.createClinicTemplate("c1", INPUT);

    expect(templatesRepository.markActive).toHaveBeenCalledWith("t1", [
      { provider: "GOOGLE", externalClassId: "x" }
    ]);
    expect(templatesRepository.markFailed).not.toHaveBeenCalled();
  });

  it("marks it failed when no provider produced a class", async () => {
    // Otherwise the dashboard would report a pass that no wallet can actually issue.
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);
    vi.mocked(templatesRepository.create).mockResolvedValue(TEMPLATE as never);
    vi.mocked(walletPassEngine.createClassForTemplate).mockResolvedValue([] as never);

    await templatesService.createClinicTemplate("c1", INPUT);

    expect(templatesRepository.markFailed).toHaveBeenCalledWith("t1");
    expect(templatesRepository.markActive).not.toHaveBeenCalled();
  });

  it("marks it failed and rethrows when the wallet call errors", async () => {
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);
    vi.mocked(templatesRepository.create).mockResolvedValue(TEMPLATE as never);
    vi.mocked(walletPassEngine.createClassForTemplate).mockRejectedValue(new Error("google 500"));

    await expect(templatesService.createClinicTemplate("c1", INPUT)).rejects.toThrow("google 500");
    expect(templatesRepository.markFailed).toHaveBeenCalledWith("t1");
  });

  it("replaces the treatment list inside the same transaction as the template", async () => {
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);
    vi.mocked(templatesRepository.create).mockResolvedValue(TEMPLATE as never);
    vi.mocked(walletPassEngine.createClassForTemplate).mockResolvedValue([] as never);

    await templatesService.createClinicTemplate("c1", INPUT);

    expect(treatmentsRepository.replaceForClinic).toHaveBeenCalledWith({}, "c1", INPUT.treatments);
  });
});

describe("updateClinicTemplate", () => {
  it("returns null for a template that does not exist", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(null as never);

    await expect(templatesService.updateClinicTemplate("missing", INPUT)).resolves.toBeNull();
    expect(asMock(templatesRepository.update)).not.toHaveBeenCalled();
  });

  it("marks it failed and rethrows when the wallet call errors", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(TEMPLATE as never);
    vi.mocked(templatesRepository.update).mockResolvedValue(TEMPLATE as never);
    vi.mocked(walletPassEngine.createClassForTemplate).mockRejectedValue(new Error("google 500"));

    await expect(templatesService.updateClinicTemplate("t1", INPUT)).rejects.toThrow("google 500");
    expect(templatesRepository.markFailed).toHaveBeenCalledWith("t1");
  });
});
