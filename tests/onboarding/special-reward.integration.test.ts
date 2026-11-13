import { MemberRewardKind, PrismaClient, type Clinic } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Settings of the original programme: this suite is not about the tuned ladder (tuning.test.ts is).
vi.mock("../../src/modules/onboarding/engine.config", async (importOriginal) => {
  const { referenceTuningMock } = await import("./reference-tuning");

  return referenceTuningMock(importOriginal as never);
});

import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../src/modules/points/prisma-points-ledger.repository";
import { PointsService } from "../../src/modules/points/points.service";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import { DOUBLE_PERK_TEXT } from "../../src/modules/onboarding/engine";
import type { Answers, CatalogItem, Program } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { PrismaProgramTierPort } from "../../src/modules/onboarding/runtime/program-tier.port";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { RewardService } from "../../src/modules/onboarding/runtime/reward.service";
import { VisitService } from "../../src/modules/onboarding/runtime/visit.service";
import { SURPRISE_TEXT } from "../../src/modules/onboarding/swap";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * Double points, a surprise and a free text on reward milestones, end to end against a real
 * database: chosen on a draft, published, crossed by a visit, and then spent, redeemed or counted
 * exactly as the engine's own perks and gifts are.
 */
const db = new PrismaClient();

let clock = new Date("2026-10-13T10:00:00Z");
const now = (): Date => clock;

const points = new PointsService(
  new PrismaPointsLedgerRepository(db),
  new PrismaMemberPointsCache(db),
  { enqueueMemberSync: async () => {}, close: async () => {} },
  { onPointsCredited: async () => {} },
  new PrismaProgramTierPort(db, now)
);
const visits = new VisitService(db, points, now);
const rewards = new RewardService(db, now);
const catalog = new PrismaCatalogRepository(db);
const onboarding = new OnboardingService(db, catalog);

const SLUG = "test-special-rewards";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

let clinic: Clinic | undefined;
let version = 0;
/** The first three rewards of the ladder: double points, a surprise, a free text. */
let at: {
  doble: { n: number; th: number };
  sorpresa: { n: number; th: number };
  libre: { n: number; th: number };
};
/** Where the reward after Diamante, made double points here, first repeats: progress euros. */
let firstRepeat = 0;
let seq = 0;

/** Never runs with an unknown clinic: an undefined id would match every row of the table. */
const clinicId = (): string => {
  if (!clinic?.id) throw new Error("the test clinic was not created");

  return clinic.id;
};

const wipeMembers = async (): Promise<void> => {
  const id = clinicId();

  await db.memberSaving.deleteMany({ where: { clinicId: id } });
  await db.memberReward.deleteMany({ where: { clinicId: id } });
  await db.paidVisit.deleteMany({ where: { clinicId: id } });
  await db.pointsTransaction.deleteMany({ where: { clinicId: id } });
  await db.member.deleteMany({ where: { clinicId: id } });
};

const wipeAll = async (): Promise<void> => {
  await wipeMembers();
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinicId() } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinicId() } });
};

const makeMember = async () => {
  seq += 1;
  const n = String(seq).padStart(3, "0");

  return db.member.create({
    data: {
      clinicId: clinicId(),
      name: `Clienta ${n}`,
      phone: `+34611000${n}`,
      code: `S${n}`.padEnd(5, "X"),
      consentMarketing: false,
      consentSource: "staff_entry",
      createdAt: clock
    }
  });
};

const pay = (memberId: string, amountEuro: number, key: string) =>
  visits.record({
    clinicId: clinicId(),
    memberId,
    kind: "PAYMENT",
    lines: [{ amountEuro }],
    idempotencyKey: key
  });

const issued = (memberId: string, n: number) =>
  db.memberReward.findFirstOrThrow({ where: { memberId, sourceKey: `v${version}:m:${n}` } });

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro especial", addressLine: "Calle Seis 6", pincode: "28006" }
  });

  await wipeAll();
  await catalog.replaceForClinic(
    clinicId(),
    (catalogFixture as CatalogItem[]).map((i) => ({
      externalId: i.id,
      name: i.name,
      priceEuro: i.price,
      isProduct: i.product ?? false,
      costPctOverride: i.costPct ?? null,
      estimated: i.estimated ?? false
    }))
  );

  const draft = await onboarding.createDraft(clinicId(), ANSWERS);
  const [first, second, third] = (draft.output as unknown as Program).chosen.map((c) => c.m.n);

  await onboarding.swapMilestone(clinicId(), draft.id, first, { kind: "doble" });
  await onboarding.swapMilestone(clinicId(), draft.id, second, { kind: "sorpresa" });
  await onboarding.swapMilestone(clinicId(), draft.id, third, {
    kind: "libre",
    name: "Manicura de regalo",
    priceEuro: 24.5
  });
  await onboarding.swapRecurringReward(clinicId(), draft.id, { kind: "doble" });

  // Whatever notes the fixture raises, this suite is about what the special rewards issue.
  const edited = await db.onboardingProgram.findUniqueOrThrow({ where: { id: draft.id } });

  await db.onboardingProgram.update({
    where: { id: draft.id },
    data: { output: { ...(edited.output as unknown as Program), review: [] } as unknown as object }
  });

  const live = await onboarding.publish(clinicId(), draft.id);
  const view = programView(live.output as unknown as Program);
  const th = (n: number): number => view.milestones.find((m) => m.n === n)!.th;

  version = live.version;
  firstRepeat = view.recurring.startsAt + view.recurring.every;
  at = {
    doble: { n: first, th: th(first) },
    sorpresa: { n: second, th: th(second) },
    libre: { n: third, th: th(third) }
  };
});

beforeEach(async () => {
  await wipeMembers();
  clock = new Date("2026-10-13T10:00:00Z");
});

afterAll(async () => {
  if (clinic?.id) {
    await wipeAll();
    await db.clinic.deleteMany({ where: { slug: SLUG } });
  }

  await db.$disconnect();
});

describe("double points on a reward milestone", () => {
  it("is issued as the double-points perk and doubles the next payment on its own", async () => {
    const m = await makeMember();

    // Bronce runs at ×1, so paying the threshold reaches it.
    await pay(m.id, at.doble.th, "reach");

    const perk = await issued(m.id, at.doble.n);

    expect(perk.kind).toBe(MemberRewardKind.VENTAJA);
    expect(perk.title).toBe(DOUBLE_PERK_TEXT.name);
    expect(perk.detail).toMatchObject({ perk: "doble" });
    expect(await rewards.doublePoints(clinicId(), m.id)).toMatchObject({
      applies: true,
      reason: "perk"
    });

    const next = await pay(m.id, 10, "doubled");

    expect(next).toMatchObject({ progress: 20, doubled: true });
    expect(
      (await db.memberReward.findUniqueOrThrow({ where: { id: perk.id } })).redeemedAt
    ).not.toBeNull();
  });

  it("cannot be redeemed by hand", async () => {
    const m = await makeMember();
    const v = await pay(m.id, at.doble.th, "reach");
    const perk = await issued(m.id, at.doble.n);

    await expect(
      rewards.redeem({ clinicId: clinicId(), rewardId: perk.id, visitId: v.visitId })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("a surprise on a reward milestone", () => {
  it("is redeemed by picking one gift from the catalogue, and refused without one", async () => {
    const m = await makeMember();
    const v = await pay(m.id, at.sorpresa.th, "reach");
    const surprise = await issued(m.id, at.sorpresa.n);
    const pool = (surprise.detail as { perk: string; pool: Array<{ id: string }> }).pool;

    expect(surprise.kind).toBe(MemberRewardKind.VENTAJA);
    expect(surprise.title).toBe(SURPRISE_TEXT.name);
    expect(pool.length).toBeGreaterThan(0);

    await expect(
      rewards.redeem({ clinicId: clinicId(), rewardId: surprise.id, visitId: v.visitId })
    ).rejects.toMatchObject({ statusCode: 400 });

    const done = await rewards.redeem({
      clinicId: clinicId(),
      rewardId: surprise.id,
      visitId: v.visitId,
      surpriseItem: pool[0].id
    });

    expect(done).toMatchObject({ status: "canjeado", surpriseItem: pool[0].id });
  });
});

describe("a free text on a reward milestone", () => {
  it("is a gift with its title, and saves the member its price when redeemed", async () => {
    const m = await makeMember();
    const v = await pay(m.id, at.libre.th, "reach");
    const gift = await issued(m.id, at.libre.n);

    expect(gift.kind).toBe(MemberRewardKind.PREMIO);
    expect(gift.title).toBe("Manicura de regalo");

    const before = (await db.member.findUniqueOrThrow({ where: { id: m.id } })).savingsCents;

    await rewards.redeem({ clinicId: clinicId(), rewardId: gift.id, visitId: v.visitId });

    const after = (await db.member.findUniqueOrThrow({ where: { id: m.id } })).savingsCents;

    expect(after - before).toBe(2450);
  });
});

describe("double points as the reward after Diamante", () => {
  it("is issued as the double-points perk on its repeat, and cannot be redeemed by hand", async () => {
    const m = await makeMember();

    // One payment straight past the first repeat, earned at Bronce's ×1.
    const v = await pay(m.id, firstRepeat, "past-diamante");
    const repeat = await db.memberReward.findFirstOrThrow({
      where: { memberId: m.id, sourceKey: `v${version}:rec:1` }
    });

    expect(repeat.kind).toBe(MemberRewardKind.VENTAJA);
    expect(repeat.title).toBe(DOUBLE_PERK_TEXT.name);
    expect(repeat.detail).toMatchObject({ perk: "doble" });
    expect(await rewards.doublePoints(clinicId(), m.id)).toMatchObject({ applies: true });

    await expect(
      rewards.redeem({ clinicId: clinicId(), rewardId: repeat.id, visitId: v.visitId })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
