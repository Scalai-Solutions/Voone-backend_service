import type { Clinic } from "@prisma/client";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CARD_REDEMPTION_SECRET ??= "test-only-redemption-secret-0123456789";
});

// The route builds its points service only when a wallet sync queue exists, as production does
// (WALLET_SYNC_MODE=queue). A queue that does nothing is enough to exercise the sign-up.
//
// Apple alone, with the throwaway signing chain: the real composition would also register Google
// from a developer's own service account and call Google's API.
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
    buildWalletSyncQueue: () => ({ enqueueMemberSync: async () => {}, close: async () => {} }),
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
import { PrismaClient } from "@prisma/client";
import { createClinicWithLogo, removeClinic } from "../admin/admin-clinics.harness";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { Answers, CatalogItem } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { MemberDirectoryService } from "../../src/modules/members/member-directory.service";
import { membersRouter } from "../../src/routes/v1/members.route";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * Sign-up through the public form with a recommendation code, over HTTP: the path a real person
 * takes. The service is covered elsewhere; this is the wiring around it, which is where a
 * referral can be lost without anyone seeing an error.
 */
const db = new PrismaClient();
let SLUG = "";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

const app = express();

app.use(express.json());
app.use("/api/v1", membersRouter);
app.use(errorHandler);

let clinic: Clinic;

const signUp = async (body: Record<string, unknown>) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/clinics/${SLUG}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    return { status: response.status, body: (await response.json()) as unknown };
  } finally {
    server.close();
  }
};

const person = (phone: string, extra: Record<string, unknown> = {}) => ({
  name: "Persona Prueba",
  phone,
  birthDate: "1990-05-10",
  sex: "otro",
  consentMarketing: false,
  acceptedPrivacy: true,
  ...extra
});

const wipe = async (): Promise<void> => {
  await db.memberSaving.deleteMany({ where: { clinicId: clinic.id } });
  await db.memberReward.deleteMany({ where: { clinicId: clinic.id } });
  await db.referral.deleteMany({ where: { clinicId: clinic.id } });
  await db.pointsTransaction.deleteMany({ where: { clinicId: clinic.id } });
  await db.walletObject.deleteMany({ where: { member: { clinicId: clinic.id } } });
  await db.member.deleteMany({ where: { clinicId: clinic.id } });
};

beforeAll(async () => {
  // The harness gives the clinic the active Wallet template a public sign-up needs.
  const made = await createClinicWithLogo(null, { isActive: true });

  SLUG = made.slug;
  clinic = await db.clinic.findUniqueOrThrow({ where: { id: made.id } });
  await wipe();
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });

  const catalog = new PrismaCatalogRepository(db);

  await catalog.replaceForClinic(
    clinic.id,
    (catalogFixture as CatalogItem[]).map((i) => ({
      externalId: i.id,
      name: i.name,
      priceEuro: i.price,
      isProduct: i.product ?? false,
      costPctOverride: i.costPct ?? null,
      estimated: i.estimated ?? false
    }))
  );

  const onboarding = new OnboardingService(db, catalog);
  const draft = await onboarding.createDraft(clinic.id, ANSWERS);

  await onboarding.publish(clinic.id, draft.id);
});

afterAll(async () => {
  await wipe();
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
  await db.walletClass.deleteMany({ where: { clinicTemplate: { clinicId: clinic.id } } });
  await removeClinic(clinic.id);
  await db.$disconnect();
});

describe("sign-up with a recommendation code", () => {
  it("records the referral when a new member gives their friend's code", async () => {
    const first = await signUp(person("+34600111001"));

    expect(first.body).toMatchObject({ status: "ok" });

    const referrer = await db.member.findFirstOrThrow({ where: { clinicId: clinic.id } });

    expect(referrer.code).toBeTruthy();

    const second = await signUp(person("+34600111002", { referredByCode: referrer.code }));

    expect(second.status).toBe(200);

    const referred = await db.member.findFirstOrThrow({
      where: { clinicId: clinic.id, phone: "+34600111002" }
    });
    const rows = await db.referral.findMany({ where: { clinicId: clinic.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referrerId: referrer.id, referredId: referred.id });
    expect(rows[0].countedAt).toBeNull();
  });

  it("records nothing, and says why in the log, when the number is already a member", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const referrer = await db.member.findFirstOrThrow({
      where: { clinicId: clinic.id, phone: "+34600111001" }
    });

    await signUp(person("+34600111001", { referredByCode: referrer.code }));

    expect(log).toHaveBeenCalledWith(
      "[referral] not recorded at sign-up",
      expect.objectContaining({ reason: "existing_member" })
    );
    log.mockRestore();
  });

  it("shows the referrer how many people they recommended and the next reward", async () => {
    const referrer = await db.member.findFirstOrThrow({
      where: { clinicId: clinic.id, phone: "+34600111001" }
    });
    const detail = await new MemberDirectoryService(db, () => new Set()).get(referrer.id);

    expect(detail.referral).toMatchObject({ referred: 1, counted: 0 });
    expect(detail.referral?.steps[0]).toMatchObject({ n: 1, reached: false });
    expect(detail.referral?.next).toMatchObject({ n: 1, remaining: 1 });
  });
});
