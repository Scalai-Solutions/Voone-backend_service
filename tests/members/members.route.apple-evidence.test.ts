import { WalletProviderType, WalletSyncStatus } from "@prisma/client";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// env.ts is parsed on first import and the redemption code needs its secret; a developer's
// own value, if any, wins.
vi.hoisted(() => {
  process.env.CARD_REDEMPTION_SECRET ??= "test-only-redemption-secret-0123456789";
});

// The real composition would also register Google from a developer's own service account
// and call Google's API. Apple alone, with the throwaway signing chain and no push channel.
vi.mock("../../src/wallet/wallet.composition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/wallet/wallet.composition")>();
  const { WalletProviderRegistry } =
    await import("../../src/wallet/engine/wallet-provider.registry");
  const { FakeRefreshChannel } = await import("../../src/wallet/engine/fake-refresh-channel");
  const { PrismaPassDeviceRepository } =
    await import("../../src/wallet/prisma-pass-device.repository");
  const { PrismaWalletSyncRepository } =
    await import("../../src/wallet/prisma-wallet-sync.repository");
  const { createAppleWalletProvider } =
    await import("../../src/wallet/providers/apple/apple-wallet.provider");

  return {
    ...actual,
    buildWalletRegistry: (prisma: import("@prisma/client").PrismaClient) => {
      const registry = new WalletProviderRegistry();

      registry.register(
        createAppleWalletProvider(
          new PrismaWalletSyncRepository(prisma),
          new FakeRefreshChannel(),
          new PrismaPassDeviceRepository(prisma),
          "https://wallet.example.test/api"
        )
      );

      return registry;
    }
  };
});

import { errorHandler } from "../../src/common/middleware/error-handler";
import { config } from "../../src/config/env";
import { applePassTypeIdentifier } from "../../src/wallet/apple-updates-registered";
import { deriveRedemptionCode } from "../../src/wallet/engine/redemption-code";
import { adminClinicsRouter } from "../../src/routes/v1/admin-clinics.route";
import { membersRouter } from "../../src/routes/v1/members.route";
import { PrismaPassDeviceRepository } from "../../src/wallet/prisma-pass-device.repository";
import { createClinicWithLogo, db, removeClinic } from "../admin/admin-clinics.harness";

/**
 * The staff and admin member payloads carry appleUpdatesRegistered; the public pass page
 * does not. And the one public route that serves a .pkpass records that it did.
 */
const app = express();

app.use(express.json());
app.use("/api/v1", membersRouter, adminClinicsRouter);
app.use(errorHandler);

const request = async (path: string, staffKey: boolean) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      headers: staffKey && config.STAFF_API_KEY ? { "x-voone-staff-key": config.STAFF_API_KEY } : {}
    });
    const type = response.headers.get("content-type") ?? "";

    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: type.includes("json") ? ((await response.json()) as any) : null
    };
  } finally {
    server.close();
  }
};

let clinic: { id: string; slug: string };
let memberId: string;
let code: string;
let passType: string;

beforeAll(async () => {
  passType = applePassTypeIdentifier() as string;
  clinic = await createClinicWithLogo(null, { isActive: true });
  // The harness gives the clinic a programme with an empty output, which the card assembler
  // cannot read. A plain points clinic is all this suite needs.
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });

  const member = await db.member.create({
    data: {
      clinicId: clinic.id,
      name: "Elena Prueba",
      consentMarketing: false,
      consentSource: "test"
    }
  });

  memberId = member.id;
  code = deriveRedemptionCode(memberId, config.CARD_REDEMPTION_SECRET as string);
});

afterEach(async () => {
  await db.passDeviceRegistration.deleteMany({ where: { passTypeIdentifier: passType } });
});

afterAll(async () => {
  const serials = (
    await db.walletObject.findMany({ where: { memberId }, select: { externalObjectId: true } })
  ).map((o) => o.externalObjectId);

  await db.passDeviceRegistration.deleteMany({ where: { serialNumber: { in: serials } } });
  await db.applePassCredential.deleteMany({ where: { serialNumber: { in: serials } } });
  await db.walletObject.deleteMany({ where: { memberId } });
  await db.member.deleteMany({ where: { clinicId: clinic.id } });
  await db.walletClass.deleteMany({ where: { clinicTemplate: { clinicId: clinic.id } } });
  await removeClinic(clinic.id);
  await db.$disconnect();
});

const adminEntry = async () => {
  const reply = await request("/admin/members", true);

  return reply.body.find((m: { id: string }) => m.id === memberId);
};

describe("appleUpdatesRegistered across the member payloads", () => {
  it("is null on the staff and admin payloads for a member with no Apple card", async () => {
    const lookup = await request(`/clinics/${clinic.slug}/members/lookup?code=${code}`, true);

    expect(lookup.status).toBe(200);
    expect(lookup.body).toHaveProperty("appleUpdatesRegistered", null);
    expect((await adminEntry()).appleUpdatesRegistered).toBeNull();
  });

  it("keeps the public pass page free of it, and issuing does not make the card look broken", async () => {
    const page = await request(`/wallet/passes/${code}`, false);

    expect(page.status).toBe(200);
    expect(page.body.member).not.toHaveProperty("appleUpdatesRegistered");

    // The Apple card now exists and is SYNCED, but nobody has downloaded or registered it.
    const apple = await db.walletObject.findFirst({
      where: { memberId, provider: WalletProviderType.APPLE }
    });

    expect(apple?.status).toBe(WalletSyncStatus.SYNCED);

    const lookup = await request(`/clinics/${clinic.slug}/members/lookup?code=${code}`, true);

    expect(lookup.body.appleUpdatesRegistered).toBeNull();
    expect((await adminEntry()).appleUpdatesRegistered).toBeNull();
  });

  it("goes false once the pass is downloaded, and true while a phone is registered", async () => {
    const download = await request(`/wallet/passes/${code}/apple.pkpass`, false);

    expect(download.status).toBe(200);

    const apple = await db.walletObject.findFirstOrThrow({
      where: { memberId, provider: WalletProviderType.APPLE }
    });
    const credential = await db.applePassCredential.findUniqueOrThrow({
      where: {
        passTypeIdentifier_serialNumber: {
          passTypeIdentifier: passType,
          serialNumber: apple.externalObjectId
        }
      }
    });

    expect(credential.downloadedAt).toBeInstanceOf(Date);

    const lookupPath = `/clinics/${clinic.slug}/members/lookup?code=${code}`;

    expect((await request(lookupPath, true)).body.appleUpdatesRegistered).toBe(false);
    expect((await adminEntry()).appleUpdatesRegistered).toBe(false);

    await new PrismaPassDeviceRepository(db).saveRegistration({
      deviceLibraryIdentifier: "device-1",
      passTypeIdentifier: passType,
      serialNumber: apple.externalObjectId,
      pushToken: "push-1"
    });

    expect((await request(lookupPath, true)).body.appleUpdatesRegistered).toBe(true);
    expect((await adminEntry()).appleUpdatesRegistered).toBe(true);
  });
});
