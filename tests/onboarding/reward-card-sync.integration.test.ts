import { MemberRewardKind, PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PointsService } from "../../src/modules/points/points.service";
import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../src/modules/points/prisma-points-ledger.repository";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { Answers, CatalogItem } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { PrismaProgramTierPort } from "../../src/modules/onboarding/runtime/program-tier.port";
import { ReferralService } from "../../src/modules/onboarding/runtime/referral.service";
import { RewardService } from "../../src/modules/onboarding/runtime/reward.service";
import { VisitService } from "../../src/modules/onboarding/runtime/visit.service";
import type { WalletSyncQueue } from "../../src/wallet/engine/wallet-sync.queue";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * When a member's card is asked to catch up, against a real database.
 *
 * The race this exists for: a visit credits points (which enqueues a card sync) BEFORE its
 * rewards exist, so that sync can assemble a card without the new reward. A second sync must
 * be asked for after the rewards are written, and after a redemption. Each queue call records
 * what the database held at that moment, which is the only way to prove the ORDER.
 */
const db = new PrismaClient();
const clock = new Date("2026-10-13T10:00:00Z");
const now = (): Date => clock;
const SLUG = "test-cardsync";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

interface Call {
  memberId: string;
  rewardRows: number;
  redeemedRows: number;
}

const calls: Call[] = [];
let failAfter = Infinity;

/** Records what the member's rewards looked like when the sync was asked for. */
const queue: WalletSyncQueue = {
  enqueueMemberSync: async (memberId) => {
    if (calls.length >= failAfter) throw new Error("queue down");

    calls.push({
      memberId,
      rewardRows: await db.memberReward.count({ where: { memberId } }),
      redeemedRows: await db.memberReward.count({ where: { memberId, redeemedAt: { not: null } } })
    });
  },
  close: async () => {}
};

const pointsWith = (q: WalletSyncQueue) =>
  new PointsService(
    new PrismaPointsLedgerRepository(db),
    new PrismaMemberPointsCache(db),
    q,
    undefined,
    new PrismaProgramTierPort(db, now)
  );

const points = pointsWith(queue);
const visits = new VisitService(db, points, now);
const rewards = new RewardService(db, now, points);
const referrals = new ReferralService(db, points);

let clinic: Clinic;
let seq = 0;

const makeMember = (code?: string) => {
  seq += 1;
  const n = String(seq).padStart(3, "0");

  return db.member.create({
    data: {
      clinicId: clinic.id,
      name: `Clienta ${n}`,
      phone: `+34611000${n}`,
      code: code ?? `S${n}`.padEnd(5, "X"),
      consentMarketing: false,
      consentSource: "staff_entry",
      createdAt: clock
    }
  });
};

const pay = (memberId: string, amountEuro: number, key: string) =>
  visits.record({
    clinicId: clinic.id,
    memberId,
    kind: "PAYMENT",
    lines: [{ amountEuro }],
    idempotencyKey: key
  });

const wipe = async (): Promise<void> => {
  await db.memberReward.deleteMany({ where: { clinicId: clinic.id } });
  await db.referral.deleteMany({ where: { clinicId: clinic.id } });
  await db.paidVisit.deleteMany({ where: { clinicId: clinic.id } });
  await db.pointsTransaction.deleteMany({ where: { clinicId: clinic.id } });
  await db.member.deleteMany({ where: { clinicId: clinic.id } });
};

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro sync", addressLine: "Calle Tres 3", pincode: "28003" }
  });
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

beforeEach(async () => {
  await wipe();
  calls.length = 0;
  failAfter = Infinity;
  seq = 0;
});

afterAll(async () => {
  await wipe();
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
  await db.clinic.deleteMany({ where: { slug: SLUG } });
  await db.$disconnect();
});

describe("asking for the card to catch up after a visit", () => {
  it("asks again after the rewards are written: credit first, rewards second", async () => {
    const m = await makeMember();
    const out = await pay(m.id, 65, "v1");

    expect(out.issued.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    // The credit's own sync, before any reward row exists: this is the race.
    expect(calls[0]).toMatchObject({ memberId: m.id, rewardRows: 0 });
    // The sync that can actually show the new reward.
    expect(calls[1]).toMatchObject({ memberId: m.id });
    expect(calls[1].rewardRows).toBe(out.issued.length);
  });

  it("does not ask a second time for a visit that issues nothing", async () => {
    const m = await makeMember();

    await pay(m.id, 65, "v1");
    calls.length = 0;

    const out = await pay(m.id, 1, "v2");

    expect(out.issued).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("asks for the referrer's card too, because the reward lands on their card", async () => {
    const referrer = await makeMember("ABCDE");
    const newcomer = await makeMember();

    await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });
    calls.length = 0;
    await pay(newcomer.id, 65, "first");

    const forReferrer = calls.filter((c) => c.memberId === referrer.id);

    expect(forReferrer).toHaveLength(1);
    expect(forReferrer[0].rewardRows).toBe(1);
  });

  it("completes the visit when the second sync request fails", async () => {
    const m = await makeMember();

    failAfter = 1;

    const out = await pay(m.id, 65, "v1");

    expect(out.issued.length).toBeGreaterThan(0);
    expect(await db.memberReward.count({ where: { memberId: m.id } })).toBe(out.issued.length);
  });

  it("completes the visit when the points service has no card-sync method at all", async () => {
    const bare = {
      balanceFor: (id: string) => points.balanceFor(id),
      credit: (request: Parameters<PointsService["credit"]>[0]) => points.credit(request)
    } as unknown as PointsService;
    const m = await makeMember();
    const out = await new VisitService(db, bare, now).record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ amountEuro: 65 }],
      idempotencyKey: "bare"
    });

    expect(out.issued.length).toBeGreaterThan(0);
  });
});

describe("asking for the card to catch up after a redemption", () => {
  const earned = async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, "v1");
    const [reward] = await db.memberReward.findMany({
      where: { memberId: m.id, kind: MemberRewardKind.PREMIO },
      orderBy: { issuedAt: "asc" }
    });

    calls.length = 0;

    return { m, v, reward };
  };

  it("asks once, after the reward is marked redeemed", async () => {
    const { m, v, reward } = await earned();

    await rewards.redeem({ clinicId: clinic.id, rewardId: reward.id, visitId: v.visitId });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ memberId: m.id, redeemedRows: 1 });
  });

  it("does not ask when the redemption is refused", async () => {
    const { reward } = await earned();

    await expect(rewards.redeem({ clinicId: clinic.id, rewardId: reward.id })).rejects.toThrow();

    expect(calls).toHaveLength(0);
  });

  it("redeems even when the queue is down", async () => {
    const { v, reward } = await earned();
    const down: WalletSyncQueue = {
      enqueueMemberSync: async () => {
        throw new Error("queue down");
      },
      close: async () => {}
    };
    const out = await new RewardService(db, now, pointsWith(down)).redeem({
      clinicId: clinic.id,
      rewardId: reward.id,
      visitId: v.visitId
    });

    expect(out.status).toBe("canjeado");
  });

  it("redeems when no card-sync port was given", async () => {
    const { v, reward } = await earned();
    const out = await new RewardService(db, now).redeem({
      clinicId: clinic.id,
      rewardId: reward.id,
      visitId: v.visitId
    });

    expect(out.status).toBe("canjeado");
  });
});
