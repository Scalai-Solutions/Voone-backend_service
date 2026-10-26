import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same seams as templates.service.test.ts: the repository, prisma and the wallet engine
// are mocked, so what is pinned here is the controller's ownership rule and nothing else.
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
  treatmentsRepository: { replaceForClinic: vi.fn() },
  vooneTemplatesRepository: {}
}));

vi.mock("../../src/infrastructure/database/prisma-client", () => ({
  prisma: {
    member: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ templateChange: { create: vi.fn() } })
    )
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

const { templatesRepository, treatmentsRepository } =
  await import("../../src/modules/templates/templates.repository");
const { templatesController } = await import("../../src/modules/templates/templates.controller");

const MINE = { id: "00000000-0000-4000-8000-000000000001", clinicId: "clinic-mine" };
const THEIRS = { id: "00000000-0000-4000-8000-000000000002", clinicId: "clinic-theirs" };

const BODY = {
  presetId: "p1",
  programName: "AURÉA Clinic Club",
  hexBackgroundColor: "#ead0bd",
  pointsLabel: "Puntos",
  tierLabel: "Nivel",
  benefitsText: "Acumula puntos en cada visita.",
  infoText: "Presenta tu pase en recepción.",
  tierRewards: [
    {
      name: "Bronze",
      rewardText: "",
      minLifetimePoints: 0,
      milestoneCount: 5,
      pointsToNextMilestone: 200
    },
    {
      name: "Silver",
      rewardText: "",
      minLifetimePoints: 1000,
      milestoneCount: 5,
      pointsToNextMilestone: 400
    },
    {
      name: "Gold",
      rewardText: "",
      minLifetimePoints: 3000,
      milestoneCount: 5,
      pointsToNextMilestone: 800
    },
    {
      name: "Platinum",
      rewardText: "",
      minLifetimePoints: 7000,
      milestoneCount: 5,
      pointsToNextMilestone: 1600
    },
    {
      name: "Diamond",
      rewardText: "",
      minLifetimePoints: 15000,
      milestoneCount: 5,
      pointsToNextMilestone: 3000
    }
  ],
  milestoneRewards: {
    milestoneCount: 10,
    pointsToNextMilestone: 2000,
    priceAmount: 10,
    pointsAwarded: 100
  }
};

const call = async (
  handler: (req: Request, res: Response) => Promise<void>,
  options: { clinicId?: string; params?: Record<string, string>; body?: unknown } = {}
) => {
  const headers: Record<string, string> = {};
  if (options.clinicId) headers["x-clinic-id"] = options.clinicId;

  const req = {
    params: options.params ?? {},
    query: {},
    body: options.body,
    header: (name: string) => headers[name.toLowerCase()]
  } as unknown as Request;

  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    }
  } as unknown as Response;

  await handler(req, res);
  return { statusCode, payload };
};

beforeEach(() => {
  vi.mocked(templatesRepository.findById).mockReset();
  vi.mocked(templatesRepository.findByClinicId).mockReset();
  vi.mocked(templatesRepository.update).mockReset();
  vi.mocked(templatesRepository.markActive).mockReset();
  vi.mocked(templatesRepository.markFailed).mockReset();
  vi.mocked(treatmentsRepository.replaceForClinic).mockReset();
  walletPassEngine.createClassForTemplate.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /templates/:templateId", () => {
  it("returns the template to the clinic that owns it", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(MINE as never);

    const result = await call(templatesController.getById, {
      clinicId: "clinic-mine",
      params: { templateId: MINE.id }
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload).toEqual(MINE);
  });

  it("answers 404, not 403, to another clinic so ids are not confirmed to exist", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(THEIRS as never);

    const result = await call(templatesController.getById, {
      clinicId: "clinic-mine",
      params: { templateId: THEIRS.id }
    });

    expect(result.statusCode).toBe(404);
    expect(result.payload).toEqual({ message: "Template not found" });
  });

  it("answers the same 404 for an id that does not exist", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(null as never);

    const result = await call(templatesController.getById, {
      clinicId: "clinic-mine",
      params: { templateId: THEIRS.id }
    });

    expect(result.statusCode).toBe(404);
    expect(result.payload).toEqual({ message: "Template not found" });
  });
});

describe("PATCH /templates/:templateId", () => {
  it("answers 404 to another clinic and touches nothing", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(THEIRS as never);

    const result = await call(templatesController.update, {
      clinicId: "clinic-mine",
      params: { templateId: THEIRS.id },
      body: BODY
    });

    expect(result.statusCode).toBe(404);
    expect(result.payload).toEqual({ message: "Template not found" });
    expect(templatesRepository.update).not.toHaveBeenCalled();
    expect(treatmentsRepository.replaceForClinic).not.toHaveBeenCalled();
    expect(walletPassEngine.createClassForTemplate).not.toHaveBeenCalled();
  });

  it("updates for the owning clinic", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(MINE as never);
    vi.mocked(templatesRepository.update).mockResolvedValue(MINE as never);

    const result = await call(templatesController.update, {
      clinicId: "clinic-mine",
      params: { templateId: MINE.id },
      body: BODY
    });

    expect(result.statusCode).toBe(200);
    expect(templatesRepository.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a write that names no clinic", async () => {
    vi.mocked(templatesRepository.findById).mockResolvedValue(MINE as never);

    const result = await call(templatesController.update, {
      params: { templateId: MINE.id },
      body: BODY
    });

    expect(result.statusCode).toBe(400);
    expect(templatesRepository.update).not.toHaveBeenCalled();
  });
});

describe("a request without a clinic", () => {
  it("is told the clinic identifier is missing, not that the payload is invalid", async () => {
    const result = await call(templatesController.list, {});

    expect(result.statusCode).toBe(400);
    expect(result.payload).toEqual({ message: "Falta el identificador del centro (x-clinic-id)." });
    expect(templatesRepository.findByClinicId).not.toHaveBeenCalled();
  });
});

describe("GET /templates", () => {
  it("lists only the template of the clinic in x-clinic-id", async () => {
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(MINE as never);

    const result = await call(templatesController.list, { clinicId: "clinic-mine" });

    expect(templatesRepository.findByClinicId).toHaveBeenCalledWith("clinic-mine");
    expect(result.payload).toEqual([MINE]);
  });

  it("lists nothing for a clinic that has no template yet", async () => {
    vi.mocked(templatesRepository.findByClinicId).mockResolvedValue(null as never);

    const result = await call(templatesController.list, { clinicId: "clinic-new" });

    expect(result.payload).toEqual([]);
  });
});
