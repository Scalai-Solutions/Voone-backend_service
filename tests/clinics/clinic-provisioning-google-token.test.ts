import { TemplateStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real engine and Google provider run here; only the sign-in library is replaced, so the
// path is the one production takes: provisionClinic -> engine -> provider -> client ->
// access token. A token-endpoint outage must read as "Google failed", not as an unknown
// error, or onboarding deletes a clinic whose only problem is Google being unreachable.
const googleAuth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function GoogleAuth() {
    return { getClient: async () => ({ getAccessToken: googleAuth.getAccessToken }) };
  })
}));

vi.mock("../../src/common/logger/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}));

const { provisionClinic } = await import("../../src/modules/clinics/clinic-provisioning.service");
const { provisionClinicSchema } =
  await import("../../src/modules/clinics/clinic-provisioning.schema");

const ENV = {
  GOOGLE_WALLET_ISSUER_ID: "3388000000000000001",
  GOOGLE_WALLET_SERVICE_ACCOUNT_KEY:
    "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n",
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "wallet@project.iam.gserviceaccount.com",
  GOOGLE_WALLET_ALLOWED_ORIGIN: "https://app.voone.example"
};
const saved = new Map<string, string | undefined>();

const template = {
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
  status: TemplateStatus.PENDING,
  clinic: { id: "c1", name: "Clínica Nova" },
  preset: { id: "p1" },
  walletClasses: []
};

const input = provisionClinicSchema.parse({
  slug: "nova7",
  name: "Clínica Nova",
  addressLine: "Carrer de Balmes 12",
  pincode: "08007",
  presetId: "p1",
  programName: "Nova Beauty Club"
});

const deletions = {
  clinicDelete: vi.fn(),
  templateDeleteMany: vi.fn(),
  walletClassDeleteMany: vi.fn(),
  treatmentDeleteMany: vi.fn()
};

const db = {
  templatePreset: {
    findUnique: vi.fn().mockResolvedValue({ id: "p1", hexBackgroundColor: "#ead0bd" })
  },
  walletClass: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
  clinicTemplate: { update: vi.fn(), findUnique: vi.fn(async () => template) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      clinic: {
        create: vi.fn().mockResolvedValue({ id: "c1", slug: "nova7" }),
        delete: deletions.clinicDelete
      },
      clinicTemplate: {
        create: vi.fn().mockResolvedValue(template),
        deleteMany: deletions.templateDeleteMany
      },
      clinicTreatment: {
        deleteMany: deletions.treatmentDeleteMany,
        createMany: vi.fn().mockResolvedValue({ count: 0 })
      },
      walletClass: { deleteMany: deletions.walletClassDeleteMany }
    })
  )
};

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  vi.clearAllMocks();
});

describe("provisionClinic when Google sign-in fails", () => {
  it("keeps the clinic and warns, deleting nothing, when the token endpoint is down", async () => {
    googleAuth.getAccessToken.mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com")
    );

    const result = await provisionClinic(db as never, input);

    expect(result.walletWarning).toBe("google_pending");
    expect(result.template.status).toBe(TemplateStatus.PENDING);
    expect(deletions.clinicDelete).not.toHaveBeenCalled();
    expect(deletions.templateDeleteMany).not.toHaveBeenCalled();
  });

  it("treats a sign-in that returns no token the same way", async () => {
    googleAuth.getAccessToken.mockResolvedValue({ token: null });

    const result = await provisionClinic(db as never, input);

    expect(result.walletWarning).toBe("google_pending");
    expect(deletions.clinicDelete).not.toHaveBeenCalled();
  });
});
