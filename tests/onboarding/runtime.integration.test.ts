import {
  MemberRewardKind,
  PointsTransactionKind,
  PrismaClient,
  VisitKind,
  type Clinic
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../src/modules/points/prisma-points-ledger.repository";
import { PointsService } from "../../src/modules/points/points.service";
import { PrismaCatalogRepository } from "../../src/modules/onboarding/catalog.repository";
import type { Answers, CatalogItem } from "../../src/modules/onboarding/engine.types";
import { toPoints } from "../../src/modules/onboarding/runtime/points-unit";
import { OnboardingService } from "../../src/modules/onboarding/onboarding.service";
import { PrismaProgramTierPort } from "../../src/modules/onboarding/runtime/program-tier.port";
import { programView } from "../../src/modules/onboarding/runtime/program-view";
import { ReferralService } from "../../src/modules/onboarding/runtime/referral.service";
import { RewardService } from "../../src/modules/onboarding/runtime/reward.service";
import { VisitService } from "../../src/modules/onboarding/runtime/visit.service";
import type { Program } from "../../src/modules/onboarding/engine.types";
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

const SLUG = "test-run";
const SLUG_NO_PROGRAM = "test-run-bare";
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
let view: ReturnType<typeof programView>;
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
  const live = await onboarding.publish(clinic.id, draft.id);

  view = programView(live.output as unknown as Program);
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

describe("recording a visit", () => {
  it("refuses while the centre has no active programme", async () => {
    const stray = await db.member.create({
      data: {
        clinicId: bare.id,
        name: "Sin programa",
        phone: "+34699999001",
        consentMarketing: false,
        consentSource: "staff_entry"
      }
    });

    await expect(
      visits.record({
        clinicId: bare.id,
        memberId: stray.id,
        kind: "PAYMENT",
        lines: [{ amountEuro: 60 }],
        idempotencyKey: "k"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("turns a payment into progress and writes it to the ledger", async () => {
    const m = await makeMember();
    const out = await pay(m.id, 65, "v1");

    expect(out).toMatchObject({
      progress: 65,
      duplicate: false,
      lifetimeBefore: 0,
      lifetimeAfter: 65
    });

    const rows = await db.pointsTransaction.findMany({ where: { memberId: m.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ points: 65, kind: PointsTransactionKind.EARN });
    expect((await memberRow(m.id)).lifetimePoints).toBe(65);
  });

  it("issues the first reward on the very first visit", async () => {
    const m = await makeMember();
    const out = await pay(m.id, 65, "v1");

    // The guide's invariant: a reward within reach of the first visit.
    expect(out.issued.length).toBeGreaterThan(0);
    expect(out.issued[0].kind).toBe(MemberRewardKind.PREMIO);
  });

  it("is idempotent: the same key twice is one payment", async () => {
    const m = await makeMember();
    const first = await pay(m.id, 65, "same");
    const second = await pay(m.id, 65, "same");

    expect(second.duplicate).toBe(true);
    expect(second.visitId).toBe(first.visitId);
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(1);
    expect(await db.paidVisit.count({ where: { memberId: m.id } })).toBe(1);
    expect(second.issued.map((r) => r.id)).toEqual(first.issued.map((r) => r.id));
  });

  it("refuses a key already used for a different client", async () => {
    const a = await makeMember();
    const b = await makeMember();

    await pay(a.id, 65, "shared");
    await expect(pay(b.id, 65, "shared")).rejects.toMatchObject({
      statusCode: 409,
      message: "Esa clave de operación ya se usó para otra persona."
    });
  });

  it("issues EVERY milestone a big purchase crosses", async () => {
    const m = await makeMember();
    const out = await pay(m.id, 1000, "big");
    const expected = view.milestones.filter((x) => x.issue && x.th <= 1000);

    expect(out.issued).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThan(5);
  });

  it("does not issue the same milestone twice across visits", async () => {
    const m = await makeMember();

    await pay(m.id, 65, "a");
    await pay(m.id, 65, "b");

    const keys = (await db.memberReward.findMany({ where: { memberId: m.id } })).map(
      (r) => r.sourceKey
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stamps an issued reward with a 60-day expiry", async () => {
    const m = await makeMember();
    await pay(m.id, 65, "v1");

    const [reward] = await db.memberReward.findMany({ where: { memberId: m.id } });

    expect(reward.expiresAt.toISOString()).toBe("2026-12-12T10:00:00.000Z");
  });

  it("rejects a payment of nothing, and an unknown category", async () => {
    const m = await makeMember();

    await expect(pay(m.id, 0, "zero")).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "PAYMENT",
        lines: [{ amountEuro: 10, category: "NOPE" as never }],
        idempotencyKey: "cat"
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("will not record a visit for a client of another centre", async () => {
    const other = await db.member.create({
      data: {
        clinicId: bare.id,
        name: "Otra",
        phone: "+34699999002",
        consentMarketing: false,
        consentSource: "staff_entry"
      }
    });

    await expect(pay(other.id, 60, "x")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("the visit result's balance", () => {
  it("states the SPENDABLE balance, as the card does, with lifetime kept apart", async () => {
    const m = await makeMember();

    await seed(m.id, 100);
    // Spent 30 progress euros (a legacy redemption, say): spendable 70, lifetime still 100.
    await points.redeem({
      memberId: m.id,
      clinicId: clinic.id,
      points: 30,
      idempotencyKey: `redeem-${m.id}`
    });

    const out = await pay(m.id, 20, "spendable-1");
    const row = await memberRow(m.id);

    expect(row.pointsBalance).toBe(90);
    expect(out.pointsTotal).toBe(900); // spendable 90 euros, in points
    expect(out.pointsTotal).toBe(toPoints(row.pointsBalance));
    expect(out.lifetimePoints).toBe(1200); // lifetime 120 euros, in points
    expect(out.lifetimeAfter).toBe(120);
  });

  it("answers a retried visit with the current spendable balance", async () => {
    const m = await makeMember();

    await pay(m.id, 20, "spendable-retry");
    await pay(m.id, 10, "spendable-later");

    const retry = await pay(m.id, 20, "spendable-retry");

    expect(retry.duplicate).toBe(true);
    expect(retry.pointsTotal).toBe(300);
  });
});

describe("what earns progress", () => {
  it("counts nothing for pharmacological medicine", async () => {
    const m = await makeMember();
    const out = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [
        { category: "FAC", amountEuro: 60 },
        { category: "MFA", amountEuro: 300 }
      ],
      idempotencyKey: "med"
    });

    // 360 euros were paid; 60 earned.
    expect(out.progress).toBe(60);
  });

  it("still records a medicine-only visit, which is a payment for redemption purposes", async () => {
    const m = await makeMember();
    const out = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ category: "MFA", amountEuro: 300 }],
      idempotencyKey: "med-only"
    });

    expect(out.progress).toBe(0);
    expect(out.issued).toEqual([]);
    // No ledger row for zero progress, but the visit exists to redeem against.
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(0);
    expect(await db.paidVisit.count({ where: { memberId: m.id } })).toBe(1);
  });

  it("adds a prepaid package's progress per session, never at purchase", async () => {
    const m = await makeMember();
    const session = (key: string) =>
      visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "BONO_SESSION",
        package: { priceEuro: 300, sessions: 6 },
        idempotencyKey: key
      });

    // A 300 euro package of six: each session is worth 50.
    expect((await session("s1")).progress).toBe(50);
    expect((await session("s2")).progress).toBe(50);
    expect((await memberRow(m.id)).lifetimePoints).toBe(100);
  });

  it("does not count a retail-only visit as a treatment", async () => {
    const m = await makeMember();
    await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ category: "COS", amountEuro: 30 }],
      idempotencyKey: "retail"
    });

    const visit = await db.paidVisit.findFirstOrThrow({ where: { memberId: m.id } });

    expect(visit.hasTreatment).toBe(false);
    expect(visit.kind).toBe(VisitKind.PAYMENT);
  });
});

describe("tiers", () => {
  it("applies the multiplier of the tier held when the client PAID", async () => {
    // Joined 13 months ago, with enough progress for Oro: 1.1x.
    const m = await makeMember({ createdAt: "2025-09-13T10:00:00Z" });
    await seed(m.id, 600);

    expect((await memberRow(m.id)).tier).toBe("Oro");
    expect((await pay(m.id, 100, "oro")).progress).toBe(110);
  });

  it("holds a client in a lower tier until their tenure is met", async () => {
    // Plenty of progress for Diamante, two months in: not a Diamante client.
    const m = await makeMember({ createdAt: "2026-08-13T10:00:00Z" });
    await seed(m.id, 1700);

    expect((await memberRow(m.id)).tier).toBe("Plata");
  });

  it("promotes the day tenure is reached, with the progress already banked", async () => {
    const m = await makeMember({ createdAt: "2025-10-14T10:00:00Z" });
    await seed(m.id, 600);

    // One day short of twelve months.
    expect((await memberRow(m.id)).tier).toBe("Plata");

    setClock("2026-10-14T10:00:00Z");
    await pay(m.id, 1, "tick");

    expect((await memberRow(m.id)).tier).toBe("Oro");
  });

  it("never takes a tier away on an ordinary movement", async () => {
    const m = await makeMember({ createdAt: "2025-09-13T10:00:00Z" });
    await seed(m.id, 600);

    // Whatever the maths would read, an ordinary credit cannot demote.
    await db.member.update({ where: { id: m.id }, data: { tier: "Platino" } });
    await seed(m.id, 1, "tiny");

    expect((await memberRow(m.id)).tier).toBe("Platino");
  });

  it("takes a tier away only on a staff correction", async () => {
    const m = await makeMember({ createdAt: "2025-09-13T10:00:00Z" });
    await seed(m.id, 600);
    expect((await memberRow(m.id)).tier).toBe("Oro");

    await points.clawBack({
      memberId: m.id,
      clinicId: clinic.id,
      points: 500,
      idempotencyKey: "oops",
      reason: "Crédito por error"
    });

    // The mistaken credit is undone for tier as well as balance.
    expect((await memberRow(m.id)).tier).toBe("Bronce");
  });

  it("leaves a centre without a programme on the legacy rules", async () => {
    const port = new PrismaProgramTierPort(db, now);

    expect(
      await port.resolve({
        memberId: "x",
        clinicId: bare.id,
        lifetime: 5000,
        current: null,
        allowDemotion: false
      })
    ).toBeNull();
  });
});

describe("double points", () => {
  const programId = async (): Promise<string> =>
    (
      await db.onboardingProgram.findFirstOrThrow({
        where: { clinicId: clinic.id, status: "ACTIVO" }
      })
    ).id;

  const grant = async (memberId: string, key: string) =>
    db.memberReward.create({
      data: {
        clinicId: clinic.id,
        memberId,
        programId: await programId(),
        kind: MemberRewardKind.VENTAJA,
        sourceKey: key,
        title: "Puntos dobles en tu próxima visita",
        detail: { perk: "doble" },
        expiresAt: new Date("2026-12-12T10:00:00Z")
      }
    });

  it("doubles the next payment, then is spent", async () => {
    const m = await makeMember();
    const perk = await grant(m.id, "m:99");

    const first = await pay(m.id, 20, "d1");

    expect(first).toMatchObject({ progress: 40, doubled: true });
    expect(
      (await db.memberReward.findUniqueOrThrow({ where: { id: perk.id } })).redeemedAt
    ).not.toBeNull();

    // Spent: the next payment is ordinary.
    expect((await pay(m.id, 20, "d2")).progress).toBe(20);
  });

  it("is not used up by a prepaid session in between", async () => {
    const m = await makeMember();
    await grant(m.id, "m:98");

    const session = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "BONO_SESSION",
      package: { priceEuro: 120, sessions: 4 },
      idempotencyKey: "s"
    });

    expect(session).toMatchObject({ progress: 30, doubled: false });
    expect(await pay(m.id, 20, "after")).toMatchObject({ progress: 40, doubled: true });
  });

  it("ignores a double that has expired", async () => {
    const m = await makeMember();
    await grant(m.id, "m:97");
    setClock("2026-12-13T10:00:00Z");

    expect(await pay(m.id, 20, "late")).toMatchObject({ progress: 20, doubled: false });
  });

  it("cannot be redeemed by hand", async () => {
    const m = await makeMember();
    const perk = await grant(m.id, "m:96");
    const v = await pay(m.id, 20, "v");

    await expect(
      rewards.redeem({ clinicId: clinic.id, rewardId: perk.id, visitId: v.visitId })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("the discount allowance", () => {
  it("gives nothing in Bronce", async () => {
    const m = await makeMember();

    await expect(
      visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "PAYMENT",
        lines: [{ category: "COS", amountEuro: 30 }],
        discountedProducts: 1,
        idempotencyKey: "d"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows three products a year in Plata and counts them down", async () => {
    const m = await makeMember({ createdAt: "2026-06-01T10:00:00Z" });
    await seed(m.id, 200);
    expect((await memberRow(m.id)).tier).toBe("Plata");

    const buy = (n: number, key: string) =>
      visits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "PAYMENT",
        lines: [{ category: "COS", amountEuro: 30 }],
        discountedProducts: n,
        idempotencyKey: key
      });

    expect((await buy(2, "a")).discountRemaining).toBe(1);
    await expect(buy(2, "b")).rejects.toMatchObject({ statusCode: 409 });
    expect((await buy(1, "c")).discountRemaining).toBe(0);
  });

  it("resets with the calendar year", async () => {
    const m = await makeMember({ createdAt: "2025-01-01T10:00:00Z" });
    await seed(m.id, 200);

    await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ category: "COS", amountEuro: 30 }],
      discountedProducts: 3,
      idempotencyKey: "year-1"
    });

    setClock("2027-01-05T10:00:00Z");
    const again = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ category: "COS", amountEuro: 30 }],
      discountedProducts: 3,
      idempotencyKey: "year-2"
    });

    expect(again.discountRemaining).toBe(0);
  });
});

describe("after Diamante", () => {
  it("issues the recurring reward every interval past the threshold", async () => {
    // Diamante: 36 months in, and past 1660.
    const m = await makeMember({ createdAt: "2023-09-01T10:00:00Z" });
    await seed(m.id, 1800);
    expect((await memberRow(m.id)).tier).toBe("Diamante");

    // 130 at the 1.3x multiplier: 1930, past 1660 + 250.
    const out = await pay(m.id, 100, "rec");

    expect(out.issued.some((r) => r.kind === MemberRewardKind.RECURRENTE)).toBe(true);
    expect(out.progress).toBe(130);
  });
});

describe("concurrency and crashes", () => {
  it("chains two simultaneous visits for the same client without losing or doubling progress", async () => {
    const m = await makeMember();
    const results = await Promise.all([
      pay(m.id, 40, "p1"),
      pay(m.id, 30, "p2"),
      pay(m.id, 20, "p3")
    ]);

    // Each visit starts where another ended: no overlap, no gap.
    const spans = results
      .map((r) => [r.lifetimeBefore, r.lifetimeAfter] as const)
      .sort((a, b) => a[0] - b[0]);

    expect(spans[0][0]).toBe(0);
    expect(spans[1][0]).toBe(spans[0][1]);
    expect(spans[2][0]).toBe(spans[1][1]);
    expect(spans[2][1]).toBe(90);
    expect((await memberRow(m.id)).lifetimePoints).toBe(90);
  });

  it("completes a visit whose credit failed, on retry, exactly once", async () => {
    // The crash this exists for: the visit committed with its numbers, then the ledger write
    // died. The retry must finish the job and neither double-pay nor skip the rewards.
    let failNext = true;
    const flaky = {
      balanceFor: (id: string) => points.balanceFor(id),
      credit: async (request: Parameters<PointsService["credit"]>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error("ledger unavailable");
        }

        return points.credit(request);
      }
    } as unknown as PointsService;
    const flakyVisits = new VisitService(db, flaky, now);
    const m = await makeMember();
    const record = () =>
      flakyVisits.record({
        clinicId: clinic.id,
        memberId: m.id,
        kind: "PAYMENT",
        lines: [{ amountEuro: 65 }],
        idempotencyKey: "retry"
      });

    await expect(record()).rejects.toThrow("ledger unavailable");

    // The visit is there, nothing was credited and nothing issued.
    expect(await db.paidVisit.count({ where: { memberId: m.id } })).toBe(1);
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(0);
    expect(await db.memberReward.count({ where: { memberId: m.id } })).toBe(0);

    const out = await record();

    expect(out.duplicate).toBe(true);
    expect(out.progress).toBe(65);
    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(1);
    expect(await db.memberReward.count({ where: { memberId: m.id } })).toBeGreaterThan(0);

    // And a further retry changes nothing.
    const rewardCount = await db.memberReward.count({ where: { memberId: m.id } });
    await record();

    expect(await db.pointsTransaction.count({ where: { memberId: m.id } })).toBe(1);
    expect(await db.memberReward.count({ where: { memberId: m.id } })).toBe(rewardCount);
  });

  it("announces a real milestone, and a tier change, to the notification path", async () => {
    const m = await makeMember();
    await pay(m.id, 65, "n1");

    // The first reward sits at 30, so 0 to 65 crosses it. No-tier to Bronce is a change.
    expect(notices.at(-1)).toMatchObject({
      memberId: m.id,
      milestoneReached: true,
      tierChanged: true
    });

    await pay(m.id, 1, "n2");

    // 65 to 66 crosses nothing and changes nothing.
    expect(notices.at(-1)).toMatchObject({ milestoneReached: false, tierChanged: false });
  });
});

describe("redeeming", () => {
  const setup = async () => {
    const m = await makeMember();
    const v = await pay(m.id, 65, `v-${seq}`);
    const [reward] = await db.memberReward.findMany({
      where: { memberId: m.id, kind: MemberRewardKind.PREMIO },
      orderBy: { issuedAt: "asc" }
    });

    return { m, v, reward };
  };

  it("redeems against a visit from today", async () => {
    const { v, reward } = await setup();
    const out = await rewards.redeem({
      clinicId: clinic.id,
      rewardId: reward.id,
      visitId: v.visitId,
      redeemedBy: "staff"
    });

    expect(out.status).toBe("canjeado");
    expect(out.redeemedAt).not.toBeNull();
  });

  it("refuses with no visit at all, because it is enforced and not a convention", async () => {
    const { reward } = await setup();

    await expect(
      rewards.redeem({ clinicId: clinic.id, rewardId: reward.id })
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/pago|bono/) });
  });

  it("refuses a visit that belongs to someone else", async () => {
    const { reward } = await setup();
    const other = await makeMember();
    const otherVisit = await pay(other.id, 65, "other");

    await expect(
      rewards.redeem({ clinicId: clinic.id, rewardId: reward.id, visitId: otherVisit.visitId })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Esa visita no corresponde a este cliente."
    });
  });

  it("refuses a second redemption", async () => {
    const { v, reward } = await setup();
    const input = { clinicId: clinic.id, rewardId: reward.id, visitId: v.visitId };

    await rewards.redeem(input);
    await expect(rewards.redeem(input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lets exactly one of two simultaneous redemptions succeed", async () => {
    const { v, reward } = await setup();
    const input = { clinicId: clinic.id, rewardId: reward.id, visitId: v.visitId };
    const results = await Promise.allSettled([rewards.redeem(input), rewards.redeem(input)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses an expired reward", async () => {
    const { m, reward } = await setup();
    setClock("2026-12-13T10:00:00Z");
    const later = await pay(m.id, 5, "later");

    await expect(
      rewards.redeem({ clinicId: clinic.id, rewardId: reward.id, visitId: later.visitId })
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/caducado/) });
  });

  it("refuses a visit from another day", async () => {
    const { reward, v } = await setup();
    setClock("2026-10-14T10:00:00Z");

    await expect(
      rewards.redeem({ clinicId: clinic.id, rewardId: reward.id, visitId: v.visitId })
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no es de hoy/) });
  });

  it("answers the same for a reward that belongs to another centre", async () => {
    const { v, reward } = await setup();

    await expect(
      rewards.redeem({ clinicId: bare.id, rewardId: reward.id, visitId: v.visitId })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("makes staff choose a surprise from its pool, and stores the choice", async () => {
    const m = await makeMember();
    const v = await pay(m.id, 1500, "huge");
    const surprise = await db.memberReward.findFirstOrThrow({
      where: {
        memberId: m.id,
        kind: MemberRewardKind.VENTAJA,
        detail: { path: ["perk"], equals: "sorpresa" }
      }
    });
    const pool = (surprise.detail as { pool: Array<{ id: string }> }).pool;
    const input = { clinicId: clinic.id, rewardId: surprise.id, visitId: v.visitId };

    await expect(rewards.redeem(input)).rejects.toMatchObject({ statusCode: 400 });
    await expect(rewards.redeem({ ...input, surpriseItem: "NOT-IN-POOL" })).rejects.toMatchObject({
      statusCode: 400
    });

    const done = await rewards.redeem({ ...input, surpriseItem: pool[0].id });

    expect(done.surpriseItem).toBe(pool[0].id);
  });

  it("lists available rewards first and keeps lapsed ones visible", async () => {
    const { m, v, reward } = await setup();
    await rewards.redeem({ clinicId: clinic.id, rewardId: reward.id, visitId: v.visitId });

    const list = await rewards.listForMember(clinic.id, m.id);
    const statuses = list.map((r) => r.status);

    expect(statuses[0]).toBe(statuses.includes("disponible") ? "disponible" : "canjeado");
    expect(statuses).toContain("canjeado");
    expect(statuses.indexOf("canjeado")).toBeGreaterThanOrEqual(
      statuses.filter((s) => s === "disponible").length
    );
  });
});

describe("double points: a waiting perk and a referred client's first payment", () => {
  const perkFor = async (memberId: string, key: string) =>
    db.memberReward.create({
      data: {
        clinicId: clinic.id,
        memberId,
        programId: (
          await db.onboardingProgram.findFirstOrThrow({
            where: { clinicId: clinic.id, status: "ACTIVO" }
          })
        ).id,
        kind: MemberRewardKind.VENTAJA,
        sourceKey: key,
        title: "Puntos dobles en tu próxima visita",
        detail: { perk: "doble" },
        expiresAt: new Date("2026-12-12T10:00:00Z")
      }
    });

  const referred = async () => {
    await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();

    await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });

    return newcomer;
  };

  const lookup = (memberId: string) => rewards.doublePoints(clinic.id, memberId);

  const earnRows = (memberId: string) =>
    db.pointsTransaction.findMany({
      where: { memberId, kind: PointsTransactionKind.EARN }
    });

  it("C1: a visit that earns nothing leaves the perk waiting", async () => {
    const m = await makeMember();
    const perk = await perkFor(m.id, "m:90");
    const out = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ category: "MFA", amountEuro: 300 }],
      idempotencyKey: "c1-med"
    });

    expect(out).toMatchObject({ progress: 0, doubled: false });
    expect(
      (await db.memberReward.findUniqueOrThrow({ where: { id: perk.id } })).redeemedAt
    ).toBeNull();
    expect(await pay(m.id, 20, "c1-next")).toMatchObject({ progress: 40, doubled: true });
  });

  it("C3: a retried doubled visit answers doubled, with the reason", async () => {
    const m = await makeMember();
    await perkFor(m.id, "m:91");

    const first = await pay(m.id, 20, "c3");
    const retry = await pay(m.id, 20, "c3");

    expect(first).toMatchObject({ doubled: true, doubleReason: "perk", duplicate: false });
    expect(retry).toMatchObject({
      doubled: true,
      doubleReason: "perk",
      duplicate: true,
      progress: 40
    });
    expect(await earnRows(m.id)).toHaveLength(1);
  });

  it("B4: a referred client's first payment is doubled, on top of the welcome credit", async () => {
    const newcomer = await referred();

    expect(await lookup(newcomer.id)).toEqual({ applies: true, reason: "referral", until: null });

    const first = await pay(newcomer.id, 20, "r1");

    expect(first).toMatchObject({ progress: 40, doubled: true, doubleReason: "referral" });
    expect(first.lifetimeAfter - first.lifetimeBefore).toBe(40);
    // The welcome credit is untouched and is still there.
    expect(
      await db.pointsTransaction.count({
        where: { memberId: newcomer.id, kind: PointsTransactionKind.REFERRAL }
      })
    ).toBe(1);

    const rows = await earnRows(newcomer.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      points: 40,
      reason: "Visita de pago (doble por recomendación)"
    });

    // Only the first one.
    expect(await lookup(newcomer.id)).toEqual({ applies: false, reason: null, until: null });
    expect(await pay(newcomer.id, 20, "r2")).toMatchObject({ progress: 20, doubled: false });
  });

  it("B4: a retried first visit stays doubled and does not mark a second first visit", async () => {
    const newcomer = await referred();

    await pay(newcomer.id, 20, "r-retry");
    const retry = await pay(newcomer.id, 20, "r-retry");

    expect(retry).toMatchObject({
      duplicate: true,
      progress: 40,
      doubled: true,
      doubleReason: "referral"
    });
    expect(await earnRows(newcomer.id)).toHaveLength(1);
    expect(await pay(newcomer.id, 20, "r-second")).toMatchObject({ progress: 20, doubled: false });
  });

  it("B4: x2 in total when a perk is also waiting, and the perk is kept", async () => {
    const newcomer = await referred();
    const perk = await perkFor(newcomer.id, "m:92");

    expect(await lookup(newcomer.id)).toMatchObject({ applies: true, reason: "referral" });

    const first = await pay(newcomer.id, 20, "both");

    expect(first).toMatchObject({ progress: 40, doubled: true, doubleReason: "referral" });
    expect(
      (await db.memberReward.findUniqueOrThrow({ where: { id: perk.id } })).redeemedAt
    ).toBeNull();

    // The client keeps what they earned: the perk doubles the next visit.
    expect(await lookup(newcomer.id)).toMatchObject({
      applies: true,
      reason: "perk",
      until: "2026-12-12T10:00:00.000Z"
    });
    expect(await pay(newcomer.id, 20, "both-2")).toMatchObject({
      progress: 40,
      doubled: true,
      doubleReason: "perk"
    });
  });

  it("B4: a first visit that earns nothing, or a prepaid session, is not the first payment", async () => {
    const newcomer = await referred();

    const med = await visits.record({
      clinicId: clinic.id,
      memberId: newcomer.id,
      kind: "PAYMENT",
      lines: [{ category: "MFA", amountEuro: 300 }],
      idempotencyKey: "r-med"
    });
    const session = await visits.record({
      clinicId: clinic.id,
      memberId: newcomer.id,
      kind: "BONO_SESSION",
      package: { priceEuro: 120, sessions: 4 },
      idempotencyKey: "r-session"
    });

    expect(med).toMatchObject({ progress: 0, doubled: false });
    expect(session).toMatchObject({ progress: 30, doubled: false });
    expect(await pay(newcomer.id, 20, "r-real")).toMatchObject({ progress: 40, doubled: true });
  });

  it("a 10-cent first payment earns nothing, so it is not the first payment and spends no perk", async () => {
    const newcomer = await referred();
    const tiny = await visits.record({
      clinicId: clinic.id,
      memberId: newcomer.id,
      kind: "PAYMENT",
      lines: [{ amountEuro: 0.1 }],
      idempotencyKey: "tiny-1"
    });

    expect(tiny).toMatchObject({ progress: 0, doubled: false, doubleReason: null });
    expect(await lookup(newcomer.id)).toMatchObject({ applies: true, reason: "referral" });
    expect(await pay(newcomer.id, 20, "tiny-real")).toMatchObject({
      progress: 40,
      doubled: true,
      doubleReason: "referral"
    });

    const m = await makeMember();
    const perk = await perkFor(m.id, "m:95");
    const out = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ amountEuro: 0.1 }],
      idempotencyKey: "tiny-2"
    });

    expect(out).toMatchObject({ progress: 0, doubled: false });
    expect(
      (await db.memberReward.findUniqueOrThrow({ where: { id: perk.id } })).redeemedAt
    ).toBeNull();
    expect(await pay(m.id, 20, "tiny-next")).toMatchObject({ progress: 40, doubled: true });
  });

  it("each visit's answer and ledger reason match the credit applied, whatever the createdAt order", async () => {
    const newcomer = await referred();
    const a = await pay(newcomer.id, 20, "order-a");
    const b = await pay(newcomer.id, 20, "order-b");

    // Clock skew: the second visit now looks older than the first.
    const first = await db.paidVisit.findUniqueOrThrow({ where: { id: a.visitId } });

    await db.paidVisit.update({
      where: { id: b.visitId },
      data: { createdAt: new Date(first.createdAt.getTime() - 5000) }
    });

    const replayA = await pay(newcomer.id, 20, "order-a");
    const replayB = await pay(newcomer.id, 20, "order-b");

    expect(a).toMatchObject({ progress: 40, doubled: true, doubleReason: "referral" });
    expect(b).toMatchObject({ progress: 20, doubled: false, doubleReason: null });
    expect(replayA).toMatchObject({ duplicate: true, doubled: true, doubleReason: "referral" });
    expect(replayB).toMatchObject({ duplicate: true, doubled: false, doubleReason: null });

    const reasons = await db.pointsTransaction.findMany({
      where: { memberId: newcomer.id, kind: PointsTransactionKind.EARN },
      select: { sourceRef: true, reason: true }
    });

    expect(reasons.find((r) => r.sourceRef === a.visitId)?.reason).toBe(
      "Visita de pago (doble por recomendación)"
    );
    expect(reasons.find((r) => r.sourceRef === b.visitId)?.reason).toBe("Visita de pago");
  });

  it("B4: a client nobody referred is never doubled by this rule", async () => {
    const m = await makeMember();

    expect(await lookup(m.id)).toEqual({ applies: false, reason: null, until: null });
    expect(await pay(m.id, 20, "plain")).toMatchObject({ progress: 20, doubled: false });
  });

  it("C4: the lookup says when a perk lapses, and not for an expired one", async () => {
    const m = await makeMember();

    await perkFor(m.id, "m:93");

    expect(await lookup(m.id)).toEqual({
      applies: true,
      reason: "perk",
      until: "2026-12-12T10:00:00.000Z"
    });

    setClock("2026-12-13T10:00:00Z");

    expect(await lookup(m.id)).toEqual({ applies: false, reason: null, until: null });
  });

  it("C4: the slider's extra adds nothing while a double applies, and counts otherwise", async () => {
    const newcomer = await referred();
    const slider = (memberId: string, key: string) =>
      visits.record({
        clinicId: clinic.id,
        memberId,
        kind: "PAYMENT",
        lines: [{ amountEuro: 20 }],
        bonusPoints: 200,
        boostMultiplier: 2,
        idempotencyKey: key
      });

    // Doubling applies: the 20 extra euros are ignored, the visit is not refused.
    expect(await slider(newcomer.id, "s1")).toMatchObject({
      progress: 40,
      doubled: true,
      bonusPoints: 0
    });
    // No double any more: the slider works as it always did.
    expect(await slider(newcomer.id, "s2")).toMatchObject({ progress: 40, doubled: false });
  });

  it("C4: a typed bonus with no slider flag still stacks, as staff typed it", async () => {
    const m = await makeMember();

    await perkFor(m.id, "m:94");

    const out = await visits.record({
      clinicId: clinic.id,
      memberId: m.id,
      kind: "PAYMENT",
      lines: [{ amountEuro: 20 }],
      bonusPoints: 50,
      idempotencyKey: "typed"
    });

    expect(out).toMatchObject({ progress: 45, doubled: true, bonusPoints: 50 });
  });
});

describe("referrals", () => {
  it("links a new member to their referrer by code, case-insensitively", async () => {
    const referrer = await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();
    const out = await referrals.register({
      clinicId: clinic.id,
      referredMemberId: newcomer.id,
      code: "abcde"
    });

    expect(out).toEqual({ registered: true, referrerId: referrer.id });
  });

  it("asks for the referred client's card to catch up, so the pending x2 shows on it", async () => {
    await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();
    const sync = vi.spyOn(points, "requestCardSync");

    await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });

    expect(sync).toHaveBeenCalledWith(newcomer.id, expect.anything());
    sync.mockRestore();
  });

  it("gives the referred client their welcome progress, once", async () => {
    await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();
    const register = () =>
      referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });

    await register();
    const again = await register();

    expect(again).toMatchObject({ registered: false, reason: "already_referred" });

    const welcome = await db.pointsTransaction.findMany({ where: { memberId: newcomer.id } });

    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({
      kind: PointsTransactionKind.REFERRAL,
      points: view.welcome
    });
  });

  it("does not count a sign-up, only a first treatment payment", async () => {
    const referrer = await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();
    await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });

    expect(await db.memberReward.count({ where: { memberId: referrer.id } })).toBe(0);

    // Retail only: not a treatment.
    await visits.record({
      clinicId: clinic.id,
      memberId: newcomer.id,
      kind: "PAYMENT",
      lines: [{ category: "COS", amountEuro: 30 }],
      idempotencyKey: "retail"
    });

    expect(await db.memberReward.count({ where: { memberId: referrer.id } })).toBe(0);
    expect(
      (await db.referral.findUniqueOrThrow({ where: { referredId: newcomer.id } })).countedAt
    ).toBeNull();
  });

  it("counts on the first treatment payment and rewards the referrer", async () => {
    const referrer = await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();
    await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });
    await pay(newcomer.id, 65, "first");

    const reward = await db.memberReward.findFirstOrThrow({
      where: { memberId: referrer.id, kind: MemberRewardKind.REFERIDO }
    });

    expect(reward.sourceKey).toBe("ref:1");
    expect(reward.title).toBe(view.referral[0].title);
  });

  it("counts it once however often the visit is retried or later visits happen", async () => {
    const referrer = await makeMember({ code: "ABCDE" });
    const newcomer = await makeMember();
    await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "ABCDE" });

    await pay(newcomer.id, 65, "first");
    await pay(newcomer.id, 65, "first");
    await pay(newcomer.id, 65, "second");

    expect(
      await db.memberReward.count({
        where: { memberId: referrer.id, kind: MemberRewardKind.REFERIDO }
      })
    ).toBe(1);
  });

  it("rewards the 1st and 3rd referral and nothing for the 2nd", async () => {
    const referrer = await makeMember({ code: "ABCDE" });

    for (let i = 1; i <= 3; i += 1) {
      const newcomer = await makeMember();
      await referrals.register({
        clinicId: clinic.id,
        referredMemberId: newcomer.id,
        code: "ABCDE"
      });
      await pay(newcomer.id, 65, `ref-${i}`);
      // Distinct instants, so the counting order is unambiguous.
      setClock(`2026-10-13T1${i}:00:00Z`);
    }

    const keys = (
      await db.memberReward.findMany({
        where: { memberId: referrer.id, kind: MemberRewardKind.REFERIDO }
      })
    )
      .map((r) => r.sourceKey)
      .sort();

    expect(keys).toEqual(["ref:1", "ref:3"]);
  });

  it("refuses a self-referral", async () => {
    const me = await makeMember({ code: "ABCDE" });

    expect(
      await referrals.register({ clinicId: clinic.id, referredMemberId: me.id, code: "ABCDE" })
    ).toMatchObject({ registered: false, reason: "self" });
  });

  it("refuses a referral for someone with the same email as the referrer", async () => {
    await makeMember({ code: "ABCDE", email: "same@example.com" });
    const duplicate = await makeMember({ email: "SAME@example.com" });

    expect(
      await referrals.register({
        clinicId: clinic.id,
        referredMemberId: duplicate.id,
        code: "ABCDE"
      })
    ).toMatchObject({ registered: false, reason: "self" });
  });

  it("refuses to attach a referral to someone who has already paid", async () => {
    await makeMember({ code: "ABCDE" });
    const regular = await makeMember();
    await pay(regular.id, 65, "regular");

    expect(
      await referrals.register({ clinicId: clinic.id, referredMemberId: regular.id, code: "ABCDE" })
    ).toMatchObject({ registered: false, reason: "too_late" });
  });

  it("never throws on a code that matches nobody", async () => {
    const newcomer = await makeMember();

    expect(
      await referrals.register({
        clinicId: clinic.id,
        referredMemberId: newcomer.id,
        code: "ZZZZZ"
      })
    ).toMatchObject({ registered: false, reason: "no_referrer" });
    expect(
      await referrals.register({ clinicId: clinic.id, referredMemberId: newcomer.id, code: "  " })
    ).toMatchObject({ registered: false, reason: "no_referrer" });
  });

  it("records nothing for a centre with no programme to reward it with", async () => {
    const a = await db.member.create({
      data: {
        clinicId: bare.id,
        name: "A",
        phone: "+34699999010",
        code: "BARE1",
        consentMarketing: false,
        consentSource: "staff_entry"
      }
    });
    const b = await db.member.create({
      data: {
        clinicId: bare.id,
        name: "B",
        phone: "+34699999011",
        consentMarketing: false,
        consentSource: "staff_entry"
      }
    });

    expect(
      await referrals.register({ clinicId: bare.id, referredMemberId: b.id, code: "BARE1" })
    ).toMatchObject({ registered: false, reason: "no_program" });
    expect(await db.referral.count({ where: { referrerId: a.id } })).toBe(0);
  });
});
