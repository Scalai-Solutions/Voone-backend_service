import {
  MemberRewardKind,
  PointsTransactionKind,
  WalletProviderType,
  WalletSyncStatus,
  type Member
} from "@prisma/client";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// env.ts is parsed on first import and the redemption code needs its secret; a developer's
// own value, if any, wins.
vi.hoisted(() => {
  process.env.CARD_REDEMPTION_SECRET ??= "test-only-redemption-secret-0123456789";
});

// The real composition would also register Google from a developer's own service account and
// call Google's API. Apple alone, with the throwaway signing chain and no push channel: enough
// for the public pass page to issue a card without reaching any real service.
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

import { generateMemberCode } from "../../src/common/utils/short-code";
import { errorHandler } from "../../src/common/middleware/error-handler";
import { config } from "../../src/config/env";
import { DashboardService } from "../../src/modules/dashboard/dashboard.service";
import { MemberDirectoryService } from "../../src/modules/members/member-directory.service";
import { NotificationService } from "../../src/modules/notifications/notification.service";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { CatalogItem } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { toPoints } from "../../src/modules/onboarding/runtime/points-unit";
import {
  PrismaProgramTierPort,
  hasActiveProgram
} from "../../src/modules/onboarding/runtime/program-tier.port";
import { VisitService } from "../../src/modules/onboarding/runtime/visit.service";
import { PointsService } from "../../src/modules/points/points.service";
import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../src/modules/points/prisma-points-ledger.repository";
import { membersRouter } from "../../src/routes/v1/members.route";
import { createPointsRouter } from "../../src/routes/v1/points.route";
import { deriveRedemptionCode } from "../../src/wallet/engine/redemption-code";
import { PrismaLoyaltyCardAssembler } from "../../src/wallet/prisma-loyalty-card.assembler";
import { createClinicWithLogo, db, removeClinic } from "../admin/admin-clinics.harness";
import catalogFixture from "../onboarding/reference/sapphira.catalogo.json";

/**
 * The same member, the same number, on every surface (the goal behind this whole task).
 *
 * One member is credited through the real services, then every place that shows a points
 * figure is asked: members list and detail, the staff lookup and the public pass page, the
 * card the wallets are built from, the Google "saldo" push, the points API, the visit result
 * at reception and the dashboard's points issued this month. At a programme centre all of them
 * must read ten points per euro of progress; at a centre without a programme, the raw number.
 */
const secret = config.CARD_REDEMPTION_SECRET as string;
const programmeCredits = { clinic: null as null | { id: string; slug: string } };
const legacyCredits = { clinic: null as null | { id: string; slug: string } };

const points = new PointsService(
  new PrismaPointsLedgerRepository(db),
  new PrismaMemberPointsCache(db),
  { enqueueMemberSync: async () => {}, close: async () => {} },
  undefined,
  new PrismaProgramTierPort(db)
);
const legacyPoints = new PointsService(
  new PrismaPointsLedgerRepository(db),
  new PrismaMemberPointsCache(db),
  { enqueueMemberSync: async () => {}, close: async () => {} }
);
const visits = new VisitService(db, points);
const directory = new MemberDirectoryService(
  db,
  () => new Set(),
  () => null
);
const dashboard = new DashboardService(
  db,
  () => ({ expiresAt: null, enabled: false }),
  () => "demo"
);

const app = express();

app.use(express.json());
app.use(
  "/api/v1",
  membersRouter,
  createPointsRouter({
    points,
    clinicOfMember: async (memberId) =>
      (await db.member.findUnique({ where: { id: memberId }, select: { clinicId: true } }))
        ?.clinicId ?? null,
    usesProgram: (clinicId) => hasActiveProgram(db, clinicId)
  })
);
app.use(errorHandler);

const send = async (method: string, path: string, body?: unknown) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        ...(config.STAFF_API_KEY ? { "x-voone-staff-key": config.STAFF_API_KEY } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await response.json()) as any
    };
  } finally {
    server.close();
  }
};

/** What the Google points push would say, with a deliberately STALE job snapshot. */
const googlePush = async (member: Member) => {
  await db.walletObject.upsert({
    where: { memberId_provider: { memberId: member.id, provider: WalletProviderType.GOOGLE } },
    update: { status: WalletSyncStatus.SYNCED },
    create: {
      memberId: member.id,
      provider: WalletProviderType.GOOGLE,
      externalObjectId: `issuer.consistency_${member.id}`,
      status: WalletSyncStatus.SYNCED
    }
  });

  const patched: number[] = [];
  const service = new NotificationService(
    db,
    {
      patchPoints: async (_id: string, patch: { points: number }) => {
        patched.push(patch.points);
      }
    } as never,
    { canPush: async () => false, recordPush: async () => undefined } as never,
    {} as never
  );

  await service.processPointsCredit({
    memberId: member.id,
    newBalance: 1,
    milestoneReached: false,
    tierChanged: false
  });

  const note = await db.notification.findFirstOrThrow({
    where: { deliveries: { some: { memberId: member.id } } },
    orderBy: { createdAt: "desc" }
  });

  return { pushed: patched[patched.length - 1], body: note.body };
};

/** Every surface's figure for one member, by name. */
const readEverywhere = async (member: Member, clinic: { id: string; slug: string }) => {
  const code = deriveRedemptionCode(member.id, secret);
  const listed = (await directory.list({ clinicId: clinic.id, limit: 10, offset: 0 })).find(
    (row) => row.id === member.id
  );
  const lookup = await send("GET", `/clinics/${clinic.slug}/members/lookup?code=${code}`);
  const passPage = await send("GET", `/wallet/passes/${code}`);
  const card = await new PrismaLoyaltyCardAssembler(db, secret).assemble(member.id);
  const push = await googlePush(member);
  const overview = await dashboard.clinicOverview(clinic.id);

  expect(lookup.status).toBe(200);
  expect(passPage.status).toBe(200);

  return {
    list: listed?.points,
    detail: (await directory.get(member.id)).points,
    lookup: lookup.body.points as number,
    passPage: passPage.body.member.points as number,
    card: card.points,
    googlePush: push.pushed,
    googleBody: push.body,
    dashboardIssued: overview.pointsIssuedThisMonth
  };
};

const wipe = async (clinicId: string): Promise<void> => {
  const serials = (
    await db.walletObject.findMany({
      where: { member: { clinicId } },
      select: { externalObjectId: true }
    })
  ).map((object) => object.externalObjectId);

  await db.passDeviceRegistration.deleteMany({ where: { serialNumber: { in: serials } } });
  await db.applePassCredential.deleteMany({ where: { serialNumber: { in: serials } } });
  await db.notificationDelivery.deleteMany({ where: { member: { clinicId } } });
  await db.notification.deleteMany({ where: { clinicId } });
  await db.memberReward.deleteMany({ where: { clinicId } });
  await db.paidVisit.deleteMany({ where: { clinicId } });
  await db.pointsTransaction.deleteMany({ where: { clinicId } });
  await db.walletObject.deleteMany({ where: { member: { clinicId } } });
  await db.member.deleteMany({ where: { clinicId } });
};

let seq = 0;

const newMember = (clinicId: string): Promise<Member> => {
  seq += 1;

  return db.member.create({
    data: {
      clinicId,
      name: `Consistencia ${seq}`,
      phone: `+3469700${String(seq).padStart(4, "0")}`,
      code: generateMemberCode(),
      consentMarketing: false,
      consentSource: "staff_entry"
    }
  });
};

beforeAll(async () => {
  programmeCredits.clinic = await createClinicWithLogo(null, { isActive: true });
  legacyCredits.clinic = await createClinicWithLogo(null, { isActive: true });

  // The harness gives both a placeholder programme with an empty output, which a card cannot be
  // built from. The legacy centre has none; the programme centre gets a real, published one.
  await db.onboardingProgram.deleteMany({
    where: { clinicId: { in: [programmeCredits.clinic.id, legacyCredits.clinic.id] } }
  });

  const catalog = new PrismaCatalogRepository(db);

  await catalog.replaceForClinic(
    programmeCredits.clinic.id,
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
  const draft = await onboarding.createDraft(programmeCredits.clinic.id, {
    ticket: null,
    freq: null,
    objective: "equilibrado",
    investment: "equilibrado",
    occupancy: "o2",
    members: "m3"
  });

  await onboarding.publish(programmeCredits.clinic.id, draft.id);
});

afterAll(async () => {
  for (const clinic of [programmeCredits.clinic, legacyCredits.clinic]) {
    if (!clinic) continue;

    await wipe(clinic.id);
    await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
    await db.walletClass.deleteMany({ where: { clinicTemplate: { clinicId: clinic.id } } });
    await removeClinic(clinic.id);
  }

  await db.$disconnect();
});

describe("a programme centre: ten points per euro, everywhere", () => {
  it("shows the same figure on every surface, before and after a correction", async () => {
    const clinic = programmeCredits.clinic as { id: string; slug: string };
    const member = await newMember(clinic.id);
    const program = await db.onboardingProgram.findFirstOrThrow({
      where: { clinicId: clinic.id, status: "ACTIVO" }
    });
    const pay = (euro: number, key: string, bonusPoints?: number) =>
      visits.record({
        clinicId: clinic.id,
        memberId: member.id,
        kind: "PAYMENT",
        lines: [{ amountEuro: euro }],
        idempotencyKey: key,
        ...(bonusPoints ? { bonusPoints } : {})
      });

    // An ordinary visit, then one doubled by a waiting perk, then one with a staff bonus.
    const first = await pay(65, "consistency-1");

    await db.memberReward.create({
      data: {
        clinicId: clinic.id,
        memberId: member.id,
        programId: program.id,
        kind: MemberRewardKind.VENTAJA,
        sourceKey: "consistency-perk",
        title: "Puntos dobles en tu próxima visita",
        detail: { perk: "doble" },
        expiresAt: new Date("2035-01-01T00:00:00Z")
      }
    });

    const doubled = await pay(20, "consistency-2");
    const bonus = await pay(10, "consistency-3", 50);

    expect(doubled.doubled).toBe(true);
    expect(bonus.bonusPoints).toBe(50);

    const expected = first.points + doubled.points + bonus.points;
    const euros = first.progress + doubled.progress + bonus.progress;

    // Not a coincidence of units: the ledger holds euros, every screen holds ten times that.
    expect(expected).toBe(euros * 10);
    expect(expected).toBeGreaterThan(euros);

    const before = await readEverywhere(member, clinic);

    expect(before).toEqual({
      list: expected,
      detail: expected,
      lookup: expected,
      passPage: expected,
      card: expected,
      googlePush: expected,
      googleBody: `Tu saldo ahora es ${expected}`,
      dashboardIssued: expected
    });
    // The visit result at reception: the spendable balance, as the card.
    expect(bonus.pointsTotal).toBe(expected);

    // A correction through the points API, in points, answers in points, and every screen follows.
    const clawBack = await send("POST", `/members/${member.id}/points/claw-back`, {
      points: 100,
      reason: "consistency check",
      idempotencyKey: "consistency-clawback-1"
    });

    expect(clawBack.status).toBe(200);
    expect(clawBack.body.balance.spendable).toBe(expected - 100);
    expect(clawBack.body.balance.spendable).toBe(
      toPoints((await db.member.findUniqueOrThrow({ where: { id: member.id } })).pointsBalance)
    );

    const after = await readEverywhere(member, clinic);

    expect(after).toMatchObject({
      list: expected - 100,
      detail: expected - 100,
      lookup: expected - 100,
      passPage: expected - 100,
      card: expected - 100,
      googlePush: expected - 100,
      googleBody: `Tu saldo ahora es ${expected - 100}`
    });
    // Issued this month counts credits only: a claw-back takes nothing off it.
    expect(after.dashboardIssued).toBe(expected);

    // And the next visit's result agrees with the card again.
    const next = await pay(10, "consistency-4");

    expect(next.pointsTotal).toBe(expected - 100 + next.points);
    expect((await readEverywhere(member, clinic)).card).toBe(next.pointsTotal);
  });
});

describe("a centre without a programme: the raw number, everywhere", () => {
  it("shows the same figure on every surface, never multiplied", async () => {
    const clinic = legacyCredits.clinic as { id: string; slug: string };
    const member = await newMember(clinic.id);
    const credit = (amount: number, key: string, kind: PointsTransactionKind) =>
      legacyPoints.credit({
        memberId: member.id,
        clinicId: clinic.id,
        points: amount,
        kind: kind as "EARN" | "REFERRAL",
        idempotencyKey: key
      });

    await credit(120, "consistency-legacy-1", PointsTransactionKind.EARN);
    await credit(30, "consistency-legacy-2", PointsTransactionKind.EARN);
    await credit(5, "consistency-legacy-3", PointsTransactionKind.REFERRAL);

    // And one through the points API, which at this centre takes and returns the raw number.
    const viaApi = await send("POST", `/members/${member.id}/points/credit`, {
      points: 15,
      idempotencyKey: "consistency-legacy-api"
    });

    expect(viaApi.status).toBe(200);
    expect(viaApi.body.balance.spendable).toBe(170);

    expect(await readEverywhere(member, clinic)).toEqual({
      list: 170,
      detail: 170,
      lookup: 170,
      passPage: 170,
      card: 170,
      googlePush: 170,
      googleBody: "Tu saldo ahora es 170",
      dashboardIssued: 170
    });
  });
});
