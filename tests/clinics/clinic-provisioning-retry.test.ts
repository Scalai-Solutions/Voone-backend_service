import { TemplateStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The retry path crosses two services: provisioning leaves the template PENDING when Google
// rejects the card, and a later template save is what flips it to ACTIVE. Same mocking
// style as templates.service.test.ts; one piece of shared state stands in for the row.
const row = vi.hoisted(() => ({ status: "PENDING" as string }));

vi.mock("../../src/modules/templates/templates.repository", () => ({
  templatesRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    markActive: vi.fn(),
    markFailed: vi.fn()
  },
  treatmentsRepository: { replaceForClinic: vi.fn() }
}));

vi.mock("../../src/infrastructure/database/prisma-client", () => ({
  prisma: {
    member: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({}))
  }
}));

vi.mock("../../src/modules/wallet-refresh/clinic-card-refresh", () => ({
  refreshClinicCards: vi.fn()
}));

const walletPassEngine = { createClassForTemplate: vi.fn() };

vi.mock("../../src/wallet/engine/wallet-pass.engine", () => ({
  WalletPassEngine: vi.fn(function WalletPassEngine() {
    return walletPassEngine;
  })
}));

vi.mock("../../src/common/logger/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}));

const { templatesRepository } = await import("../../src/modules/templates/templates.repository");
const { templatesService } = await import("../../src/modules/templates/templates.service");
const { provisionClinic } = await import("../../src/modules/clinics/clinic-provisioning.service");
const { provisionClinicSchema } =
  await import("../../src/modules/clinics/clinic-provisioning.schema");
const { GoogleWalletApiError } = await import("../../src/wallet/providers/google/client");

const template = () => ({
  id: "t1",
  clinicId: "c1",
  presetId: "p1",
  programName: "Nova Beauty Club",
  status: row.status,
  clinic: { id: "c1", name: "Clínica Nova" },
  preset: { id: "p1" },
  walletClasses: []
});

const provisioningDb = () => ({
  templatePreset: {
    findUnique: vi.fn().mockResolvedValue({ id: "p1", hexBackgroundColor: "#ead0bd" })
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ clinic: { create: vi.fn().mockResolvedValue({ id: "c1", slug: "nova7" }) } })
  ),
  clinicTemplate: { findUnique: vi.fn(async () => template()) }
});

beforeEach(() => {
  row.status = "PENDING";
  vi.mocked(templatesRepository.create).mockReset();
  vi.mocked(templatesRepository.findById).mockReset();
  vi.mocked(templatesRepository.update).mockReset();
  vi.mocked(templatesRepository.markActive).mockReset();
  vi.mocked(templatesRepository.markFailed).mockReset();
  walletPassEngine.createClassForTemplate.mockReset();

  vi.mocked(templatesRepository.create).mockImplementation((async () => template()) as never);
  vi.mocked(templatesRepository.findById).mockImplementation((async () => template()) as never);
  vi.mocked(templatesRepository.update).mockImplementation((async () => template()) as never);
  vi.mocked(templatesRepository.markActive).mockImplementation((async () => {
    row.status = TemplateStatus.ACTIVE;
  }) as never);
});

describe("a Google failure at creation, then a successful save", () => {
  it("leaves the template PENDING at creation and ACTIVE after the next successful update", async () => {
    walletPassEngine.createClassForTemplate.mockRejectedValueOnce(
      new GoogleWalletApiError("Invalid class", 400, "Bad Request")
    );

    const created = await provisionClinic(
      provisioningDb() as never,
      provisionClinicSchema.parse({
        slug: "nova7",
        name: "Clínica Nova",
        addressLine: "Carrer de Balmes 12",
        pincode: "08007",
        presetId: "p1",
        programName: "Nova Beauty Club"
      })
    );

    expect(created.walletWarning).toBe("google_pending");
    expect(created.template.status).toBe(TemplateStatus.PENDING);
    expect(templatesRepository.markActive).not.toHaveBeenCalled();

    walletPassEngine.createClassForTemplate.mockResolvedValueOnce([
      { provider: "GOOGLE", externalClassId: "issuer.nova" }
    ]);

    const updated = await templatesService.updateClinicTemplate("t1", "c1", {
      programName: "Nova Beauty Club"
    } as never);

    expect(templatesRepository.markActive).toHaveBeenCalledWith("t1", [
      { provider: "GOOGLE", externalClassId: "issuer.nova" }
    ]);
    expect(updated?.status).toBe(TemplateStatus.ACTIVE);
  });
});
