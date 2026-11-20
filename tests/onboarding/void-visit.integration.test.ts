import {
  MemberRewardKind,
  MemberSavingKind,
  PointsTransactionKind,
  PrismaClient,
  type Clinic
} from "@prisma/client";
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
import type { Answers, CatalogItem } from "../../src/modules/onboarding/engine.types";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { PrismaProgramTierPort } from "../../src/modules/onboarding/runtime/program-tier.port";
import { ReferralService } from "../../src/modules/onboarding/runtime/referral.service";
import { RewardService } from "../../src/modules/onboarding/runtime/reward.service";
import { VisitService, VOID_WINDOW_MS } from "../../src/modules/onboarding/runtime/visit.service";
import catalogFixture from "./reference/sapphira.catalogo.json";

/**
 * The runtime, end to end, against a real database.
 *
 * Mocks cannot prove what matters here. The interesting behaviour is in the interactions:
 * two visits for the same person at the same moment, a crash between writing a visit and
 * crediting it, a reward redeemed by two receptionists at once, a tenure rule meeting a
 * progress rule. Each of those is a property of rows and locks, so each is tested on rows
 * and locks.
 */
const db = new PrismaClient();

let clock = new Date("2026-10-13T10:00:00Z");
const now = (): Date => clock;
const setClock = (iso: string): void => {
  clock = new Date(iso);
};

interface Notice {
  memberId: string;
  milestoneReached: boolean;
  tierChanged: boolean;
}
const notices: Notice[] = [];

const points = new PointsService(
  new PrismaPointsLedgerRepository(db),
  new PrismaMemberPointsCache(db),
  { enqueueMemberSync: async () => {}, close: async () => {} },
  {
    onPointsCredited: async (memberId, _balance, flags) => {
      notices.push({ memberId, ...flags });
    }
  },
  new PrismaProgramTierPort(db, now)
);

const visits = new VisitService(db, points, now);
const rewards = new RewardService(db, now);
const referrals = new ReferralService(db, points);

const SLUG = "test-void-visit";
const SLUG_NO_PROGRAM = "test-void-visit-bare";
const ANSWERS: Answers = {
  ticket: null,
  freq: null,
  objective: "equilibrado",
  investment: "equilibrado",
  occupancy: "o2",
  members: "m3"
};

let clinic: Clinic;
let bare: Clinic;
let seq = 0;

const fixture = catalogFixture as CatalogItem[];

/** A member, with a signup date we control so tenure can be tested. */
const makeMember = async (over: { createdAt?: string; code?: string; email?: string } = {}) => {
  seq += 1;
  const n = String(seq).padStart(3, "0");

  return db.member.create({
    data: {
      clinicId: clinic.id,
      name: `Clienta ${n}`,
      phone: `+34600000${n}`,
      email: over.email,
      code: over.code ?? `T${n}`.padEnd(5, "X"),
      consentMarketing: false,
      consentSource: "staff_entry",
      createdAt: over.createdAt ? new Date(over.createdAt) : clock
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

/** Seed progress directly through the ledger, as a prior history would have. */
const seed = (memberId: string, amount: number, key = `seed-${memberId}-${amount}`) =>
  points.credit({
    memberId,
    clinicId: clinic.id,
    points: amount,
    kind: PointsTransactionKind.EARN,
    idempotencyKey: key
  });

const memberRow = (id: string) => db.member.findUniqueOrThrow({ where: { id } });

const wipe = async (clinicId: string): Promise<void> => {
  await db.memberSaving.deleteMany({ where: { clinicId } });
  await db.memberBono.deleteMany({ where: { clinicId } });
  await db.bonoPlan.deleteMany({ where: { clinicId } });
  await db.memberReward.deleteMany({ where: { clinicId } });
  await db.referral.deleteMany({ where: { clinicId } });
  await db.paidVisit.deleteMany({ where: { clinicId } });
  await db.pointsTransaction.deleteMany({ where: { clinicId } });
  await db.member.deleteMany({ where: { clinicId } });
};

beforeAll(async () => {
  clinic = await db.clinic.upsert({
    where: { slug: SLUG },
    update: {},
    create: { slug: SLUG, name: "Centro de prueba", addressLine: "Calle Uno 1", pincode: "28001" }
  });
  bare = await db.clinic.upsert({
    where: { slug: SLUG_NO_PROGRAM },
    update: {},
    create: {
      slug: SLUG_NO_PROGRAM,
      name: "Sin programa",
      addressLine: "Calle Dos 2",
      pincode: "28002"
    }
  });

  await wipe(clinic.id);
  await wipe(bare.id);
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });

  const catalog = new PrismaCatalogRepository(db);
  await catalog.replaceForClinic(
    clinic.id,
    fixture.map((i) => ({
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
  await wipe(clinic.id);
  await wipe(bare.id);
  setClock("2026-10-13T10:00:00Z");
  notices.length = 0;
  seq = 0;
});

afterAll(async () => {
  await wipe(clinic.id);
  await wipe(bare.id);
  await db.onboardingProgram.deleteMany({ where: { clinicId: clinic.id } });
  await db.catalogItem.deleteMany({ where: { clinicId: clinic.id } });
  await db.clinic.deleteMany({ where: { slug: { in: [SLUG, SLUG_NO_PROGRAM] } } });
  await db.$disconnect();
});

const voidIt = (visitId: string, extra: { reason?: string; voidedBy?: string } = {}) =>
  visits.voidVisit({ clinicId: clinic.id, visitId, ...extra });

describe("voiding a visit", () => {
  it("takes back the progress and keeps the visit, marked", async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, "v1");

    const out = await voidIt(v.visitId, {
      reason: "Importe equivocado",
      voidedBy: "ana@centro.es"
    });

    expect(out).toMatchObject({ visitId: v.visitId, duplicate: false, pointsTotal: 0 });

    const row = await db.paidVisit.findUniqueOrThrow({ where: { id: v.visitId } });

    expect(row.voidedAt).not.toBeNull();
    expect(row).toMatchObject({ voidedBy: "ana@centro.es", voidReason: "Importe equivocado" });

    const member = await memberRow(m.id);

    expect(member.pointsBalance).toBe(0);
    expect(member.lifetimePoints).toBe(0);

    const ledger = await db.pointsTransaction.findMany({
      where: { memberId: m.id },
      orderBy: { createdAt: "asc" }
    });

    expect(ledger.map((row) => [row.kind, row.points])).toEqual([
      [PointsTransactionKind.EARN, 65],
      [PointsTransactionKind.ADJUSTMENT, -65]
    ]);
    expect(ledger[1].idempotencyKey).toBe(`void:${v.visitId}`);
  });

  it("is idempotent: voiding twice takes back once", async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, "v1");

    await voidIt(v.visitId);
    const again = await voidIt(v.visitId);

    expect(again.duplicate).toBe(true);
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(2);
  });

  it("finishes a void whose ledger row never got written, on retry", async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, "v1");

    // The commit that marks the visit happened; the process died before the ledger row.
    await db.paidVisit.update({ where: { id: v.visitId }, data: { voidedAt: clock } });

    await voidIt(v.visitId);

    expect((await memberRow(m.id)).pointsBalance).toBe(0);
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(2);
  });

  it("answers 404 for a visit of another centre", async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, "v1");

    await expect(visits.voidVisit({ clinicId: bare.id, visitId: v.visitId })).rejects.toMatchObject(
      { statusCode: 404 }
    );
  });

  it("refuses a retry of the voided visit's own key, instead of calling it a success", async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, "v1");

    await voidIt(v.visitId);

    await expect(pay(m.id, 65, "v1")).rejects.toMatchObject({
      statusCode: 409,
      message: "Esa visita se anuló. Registra una visita nueva para que cuente."
    });
  });

  it("lets the corrected visit be recorded, and counts only that one", async () => {
    const m = await makeMember();
    const wrong = await pay(m.id, 650, "wrong");

    await voidIt(wrong.visitId);
    const right = await pay(m.id, 65, "right");

    expect(right).toMatchObject({ lifetimeBefore: 0, lifetimeAfter: 65 });
    expect((await memberRow(m.id)).pointsBalance).toBe(65);
  });

  describe("what the visit issued", () => {
    it("closes the rewards its progress issued, and frees them to be earned again", async () => {
      const m = await makeMember();
      const v = await pay(m.id, 65, "v1");

      expect(v.issued.length).toBeGreaterThan(0);

      await voidIt(v.visitId);

      const rows = await db.memberReward.findMany({ where: { memberId: m.id } });

      expect(rows).toHaveLength(v.issued.length);

      for (const row of rows) {
        expect(row.sourceKey.startsWith(`voided:${v.visitId}:`)).toBe(true);
        expect(row.expiresAt.getTime()).toBeLessThanOrEqual(clock.getTime());
        expect(row.redeemedAt).toBeNull();
      }

      // Crossing the same step again, honestly this time, issues it again.
      const again = await pay(m.id, 65, "v2");

      expect(again.issued).toHaveLength(v.issued.length);
      expect(again.issued.every((reward) => reward.expiresAt.getTime() > clock.getTime())).toBe(
        true
      );
    });

    it("refuses when a reward the visit issued has been redeemed", async () => {
      const m = await makeMember();
      const v = await pay(m.id, 65, "v1");
      const [reward] = await db.memberReward.findMany({
        where: { memberId: m.id, kind: MemberRewardKind.PREMIO }
      });

      await rewards.redeem({ clinicId: clinic.id, rewardId: reward.id, redeemedBy: "staff" });

      await expect(voidIt(v.visitId)).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await db.paidVisit.findUniqueOrThrow({ where: { id: v.visitId } })).voidedAt
      ).toBeNull();
      expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(1);
    });

    it("refuses when the visit itself was used to redeem something", async () => {
      const m = await makeMember();
      await pay(m.id, 65, "first");
      const second = await pay(m.id, 5, "second");
      const [reward] = await db.memberReward.findMany({
        where: { memberId: m.id, kind: MemberRewardKind.PREMIO }
      });

      await rewards.redeem({
        clinicId: clinic.id,
        rewardId: reward.id,
        visitId: second.visitId,
        redeemedBy: "staff"
      });

      await expect(voidIt(second.visitId)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe("when it is refused", () => {
    it("refuses after 24 hours, counted from when it was recorded", async () => {
      const m = await makeMember();
      const v = await pay(m.id, 65, "v1");
      const recorded = (await db.paidVisit.findUniqueOrThrow({ where: { id: v.visitId } }))
        .createdAt;

      setClock(new Date(recorded.getTime() + VOID_WINDOW_MS + 1000).toISOString());

      await expect(voidIt(v.visitId)).rejects.toMatchObject({
        statusCode: 409,
        message: "Solo se puede anular una visita durante las 24 horas siguientes a registrarla."
      });

      setClock(new Date(recorded.getTime() + VOID_WINDOW_MS - 1000).toISOString());

      await expect(voidIt(v.visitId)).resolves.toMatchObject({ duplicate: false });
    });

    it("counts the window from when it was recorded, not from the date entered", async () => {
      const m = await makeMember();
      const old = await visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "PAYMENT",
        lines: [{ amountEuro: 65 }],
        occurredAt: new Date("2026-01-05T10:00:00Z"),
        idempotencyKey: "backdated"
      });

      // A visit typed in for a date months ago is still brand new in the books.
      await expect(voidIt(old.visitId)).resolves.toMatchObject({ duplicate: false });
    });

    it("refuses a visit that is not the client's latest", async () => {
      const m = await makeMember();
      const first = await pay(m.id, 65, "v1");
      const second = await pay(m.id, 20, "v2");

      await expect(voidIt(first.visitId)).rejects.toMatchObject({ statusCode: 409 });

      // Undoing them newest first is how it is done.
      await voidIt(second.visitId);
      await expect(voidIt(first.visitId)).resolves.toMatchObject({ duplicate: false });
      expect((await memberRow(m.id)).pointsBalance).toBe(0);
    });

    it("refuses when the points have already been spent", async () => {
      const m = await makeMember();
      const v = await pay(m.id, 65, "v1");

      await points.redeem({
        memberId: m.id,
        clinicId: clinic.id,
        points: 40,
        idempotencyKey: "spend"
      });

      await expect(voidIt(v.visitId)).rejects.toMatchObject({ statusCode: 409 });
      expect((await memberRow(m.id)).pointsBalance).toBe(25);
    });

    it("refuses the visit that made a referral count for someone else", async () => {
      const referrer = await makeMember({ code: "ABCDE" });
      const newcomer = await makeMember();

      await referrals.register({
        clinicId: clinic.id,
        referredMemberId: newcomer.id,
        code: "ABCDE"
      });
      const v = await pay(newcomer.id, 65, "first-treatment");

      expect(
        (await db.referral.findUniqueOrThrow({ where: { referredId: newcomer.id } })).countedAt
      ).not.toBeNull();

      await expect(voidIt(v.visitId)).rejects.toMatchObject({ statusCode: 409 });
      expect(referrer.id).toBeTruthy();
    });

    it("allows voiding a referred client's retail-only visit, which counted for nobody", async () => {
      await makeMember({ code: "ABCDE" });
      const newcomer = await makeMember();

      await referrals.register({
        clinicId: clinic.id,
        referredMemberId: newcomer.id,
        code: "ABCDE"
      });
      const retail = await visits.record({
        clinicId: clinic.id,
        memberId: newcomer.id,
        kind: "PAYMENT",
        lines: [{ category: "COS", amountEuro: 30 }],
        idempotencyKey: "retail"
      });

      await expect(voidIt(retail.visitId)).resolves.toMatchObject({ duplicate: false });
    });
  });

  describe("the tier", () => {
    it("takes the tier back with the progress", async () => {
      const m = await makeMember({ createdAt: "2026-06-01T10:00:00Z" });
      await seed(m.id, 200);
      expect((await memberRow(m.id)).tier).toBe("Plata");

      const big = await pay(m.id, 1500, "big");
      const reached = (await memberRow(m.id)).tier;

      expect(reached).not.toBe("Plata");

      await voidIt(big.visitId);

      expect((await memberRow(m.id)).tier).toBe("Plata");
    });
  });

  describe("the discount on cosmetics", () => {
    const buy = (memberId: string, key: string, n = 1) =>
      visits.record({
        clinicId: clinic.id,
        memberId,
        kind: "PAYMENT",
        lines: Array.from({ length: n }, () => ({
          category: "COS" as const,
          amountEuro: 30,
          discountedListPriceEuro: 40
        })),
        discountedProducts: n,
        idempotencyKey: key
      });

    it("takes back the saving and gives the month's allowance back", async () => {
      const m = await makeMember({ createdAt: "2026-06-01T10:00:00Z" });
      await seed(m.id, 200);

      const first = await buy(m.id, "a", 3);

      expect(first.discountRemaining).toBe(0);
      expect((await memberRow(m.id)).savingsCents).toBeGreaterThan(0);

      await voidIt(first.visitId);

      expect((await memberRow(m.id)).savingsCents).toBe(0);

      const adjustment = await db.memberSaving.findFirstOrThrow({
        where: { memberId: m.id, kind: MemberSavingKind.ADJUSTMENT }
      });

      expect(adjustment.cents).toBeLessThan(0);
      expect(adjustment.sourceKey).toBe(`void:visit:${first.visitId}`);

      // All three discounted products are available again.
      expect((await buy(m.id, "b", 1)).discountRemaining).toBe(2);
    });
  });

  describe("a prepaid package session", () => {
    it("hands the session back, so the next one takes the same number", async () => {
      const m = await makeMember();
      const plan = await db.bonoPlan.create({
        data: {
          clinicId: clinic.id,
          name: "Pack láser",
          pricePerSessionCents: 5000,
          totalSessions: 3
        }
      });
      const session = (key: string) =>
        visits.record({
          clinicId: clinic.id,
          memberId: m.id,
          kind: "BONO_SESSION",
          planId: plan.id,
          idempotencyKey: key
        });

      const one = await session("s1");
      const two = await session("s2");

      expect(two.bono).toMatchObject({ session: 2 });

      await voidIt(two.visitId);

      const bono = await db.memberBono.findFirstOrThrow({ where: { memberId: m.id } });

      expect(bono).toMatchObject({ sessionsUsed: 1, status: "ACTIVE" });
      expect(
        (await db.paidVisit.findUniqueOrThrow({ where: { id: two.visitId } })).bonoSessionNumber
      ).toBeNull();

      const again = await session("s2-again");

      expect(again.bono).toMatchObject({ session: 2 });
      expect(one.bono).toMatchObject({ session: 1 });
    });

    it("reopens a bono whose last session is voided", async () => {
      const m = await makeMember();
      const plan = await db.bonoPlan.create({
        data: {
          clinicId: clinic.id,
          name: "Pack corto",
          pricePerSessionCents: 5000,
          totalSessions: 1
        }
      });
      const last = await visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "BONO_SESSION",
        planId: plan.id,
        idempotencyKey: "only"
      });

      expect((await db.memberBono.findFirstOrThrow({ where: { memberId: m.id } })).status).toBe(
        "COMPLETED"
      );

      await voidIt(last.visitId);

      expect(await db.memberBono.findFirstOrThrow({ where: { memberId: m.id } })).toMatchObject({
        sessionsUsed: 0,
        status: "ACTIVE"
      });
    });
  });

  describe("a visit that earned nothing", () => {
    it("voids with no ledger row to take back", async () => {
      const m = await makeMember();
      const medicine = await visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "PAYMENT",
        lines: [{ category: "MFA", amountEuro: 50 }],
        idempotencyKey: "med"
      });

      await expect(voidIt(medicine.visitId)).resolves.toMatchObject({ duplicate: false });
      expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(0);
    });
  });
});
