import {
  MemberRewardKind,
  OnboardingProgramStatus,
  PointsTransactionKind,
  PrismaClient,
  VisitKind,
  WalletProviderType,
  type Clinic,
  type Member
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DashboardService } from "../../src/modules/dashboard/dashboard.service";

/**
 * The dashboard aggregates against a real database.
 *
 * The month is a Madrid calendar month: a visit at 23:30 on the last day and one at 00:30 on
 * the 1st sit on different sides of the boundary whichever offset (CET or CEST) is in force,
 * and UTC would put both on the wrong side in one regime or the other.
 */
const db = new PrismaClient();

const PROGRAMME_SLUG = "dash-agg-programme";
const LEGACY_SLUG = "dash-agg-legacy";

let programme: Clinic;
let legacy: Clinic;
let programId: string;
let seq = 0;

const serviceAt = (iso: string) =>
  new DashboardService(
    db,
    () => ({ expiresAt: null, enabled: false }),
    () => "demo",
    () => new Date(iso)
  );

const wipe = async (clinicId: string): Promise<void> => {
  await db.memberReward.deleteMany({ where: { clinicId } });
  await db.paidVisit.deleteMany({ where: { clinicId } });
  await db.pointsTransaction.deleteMany({ where: { clinicId } });
  await db.walletObject.deleteMany({ where: { member: { clinicId } } });
  await db.member.deleteMany({ where: { clinicId } });
};

const makeMember = (clinicId: string, name: string, erased = false): Promise<Member> => {
  seq += 1;

  return db.member.create({
    data: {
      clinicId,
      name,
      phone: `+3469900${String(seq).padStart(4, "0")}`,
      consentMarketing: false,
      consentSource: "staff_entry",
      erasedAt: erased ? new Date() : null
    }
  });
};

const visit = (clinicId: string, memberId: string, amountCents: number, at: string) => {
  seq += 1;

  return db.paidVisit.create({
    data: {
      clinicId,
      memberId,
      kind: VisitKind.PAYMENT,
      amountCents,
      idempotencyKey: `dash-visit-${seq}`,
      occurredAt: new Date(at)
    }
  });
};

const ledger = (
  clinicId: string,
  memberId: string,
  points: number,
  kind: PointsTransactionKind,
  at: string
) => {
  seq += 1;

  return db.pointsTransaction.create({
    data: {
      clinicId,
      memberId,
      points,
      kind,
      idempotencyKey: `dash-ledger-${seq}`,
      createdAt: new Date(at)
    }
  });
};

const reward = (
  clinicId: string,
  memberId: string,
  redeemedAt: string | null,
  detail: Record<string, string> = {}
) => {
  seq += 1;

  return db.memberReward.create({
    data: {
      clinicId,
      memberId,
      programId,
      kind: MemberRewardKind.VENTAJA,
      sourceKey: `dash-reward-${seq}`,
      title: "Perk",
      detail,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      redeemedAt: redeemedAt ? new Date(redeemedAt) : null
    }
  });
};

beforeAll(async () => {
  for (const slug of [PROGRAMME_SLUG, LEGACY_SLUG]) {
    const existing = await db.clinic.findUnique({ where: { slug } });

    if (existing) {
      await wipe(existing.id);
      await db.onboardingProgram.deleteMany({ where: { clinicId: existing.id } });
    }
  }

  programme = await db.clinic.upsert({
    where: { slug: PROGRAMME_SLUG },
    update: {},
    create: {
      slug: PROGRAMME_SLUG,
      name: "Dashboard programa",
      addressLine: "C 1",
      pincode: "28001"
    }
  });
  legacy = await db.clinic.upsert({
    where: { slug: LEGACY_SLUG },
    update: {},
    create: { slug: LEGACY_SLUG, name: "Dashboard clasico", addressLine: "C 2", pincode: "28002" }
  });

  const program = await db.onboardingProgram.create({
    data: {
      clinicId: programme.id,
      version: 1,
      status: OnboardingProgramStatus.ACTIVO,
      engineVersion: "test",
      configVersion: "test",
      answers: {},
      output: {},
      catalogSnapshot: [],
      publishedAt: new Date("2026-01-01T00:00:00Z")
    }
  });

  programId = program.id;
});

beforeEach(async () => {
  await wipe(programme.id);
  await wipe(legacy.id);
});

afterAll(async () => {
  await wipe(programme.id);
  await wipe(legacy.id);
  await db.onboardingProgram.deleteMany({ where: { clinicId: programme.id } });
  await db.clinic.deleteMany({ where: { slug: { in: [PROGRAMME_SLUG, LEGACY_SLUG] } } });
  await db.$disconnect();
});

describe("clinicOverview: money", () => {
  /**
   * October 2026 contains both regimes: summer time until Sunday the 25th, winter time after.
   * Madrid October = [2026-09-30T22:00Z, 2026-10-31T23:00Z).
   */
  it("sums only this Madrid month, at both edges, in either offset", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await visit(programme.id, ana.id, 5000, "2026-09-30T21:30:00Z"); // 30 Sep 23:30 CEST: before
    await visit(programme.id, ana.id, 10000, "2026-09-30T22:30:00Z"); // 1 Oct 00:30 CEST: in
    await visit(programme.id, ana.id, 2000, "2026-10-31T22:30:00Z"); // 31 Oct 23:30 CET: in
    await visit(programme.id, ana.id, 7000, "2026-10-31T23:30:00Z"); // 1 Nov 00:30 CET: after

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.revenueThisMonthCents).toBe(12000);
    expect(overview.moneySpentTotalCents).toBe(24000);
    expect(overview.revenueAllTimeCents).toBe(24000);
  });

  it("applies the winter offset to a January month", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await visit(programme.id, ana.id, 1000, "2026-12-31T22:30:00Z"); // 31 Dec 23:30 CET: before
    await visit(programme.id, ana.id, 3000, "2026-12-31T23:30:00Z"); // 1 Jan 00:30 CET: in
    await visit(programme.id, ana.id, 4000, "2027-01-31T22:30:00Z"); // 31 Jan 23:30 CET: in
    await visit(programme.id, ana.id, 9000, "2027-01-31T23:30:00Z"); // 1 Feb 00:30 CET: after

    const overview = await serviceAt("2027-01-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.revenueThisMonthCents).toBe(7000);
  });

  it("applies the summer offset to a July month", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await visit(programme.id, ana.id, 1000, "2026-06-30T21:30:00Z"); // 30 Jun 23:30 CEST: before
    await visit(programme.id, ana.id, 3000, "2026-06-30T22:30:00Z"); // 1 Jul 00:30 CEST: in
    await visit(programme.id, ana.id, 4000, "2026-07-31T21:30:00Z"); // 31 Jul 23:30 CEST: in
    await visit(programme.id, ana.id, 9000, "2026-07-31T22:30:00Z"); // 1 Aug 00:30 CEST: after

    const overview = await serviceAt("2026-07-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.revenueThisMonthCents).toBe(7000);
  });

  it("never counts another clinic's visits", async () => {
    const ana = await makeMember(programme.id, "Ana");
    const other = await makeMember(legacy.id, "Otra");

    await visit(programme.id, ana.id, 1000, "2026-10-10T10:00:00Z");
    await visit(legacy.id, other.id, 99900, "2026-10-10T10:00:00Z");

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.revenueThisMonthCents).toBe(1000);
    expect(overview.moneySpentTotalCents).toBe(1000);
  });
});

describe("clinicOverview: top clients", () => {
  it("ranks the five biggest spenders this month, by money, skipping erased members", async () => {
    const names = ["Ana", "Berta", "Carla", "Diana", "Elena", "Flor"];
    const members = await Promise.all(names.map((n) => makeMember(programme.id, n)));
    const gone = await makeMember(programme.id, "Miembro eliminado", true);

    // Flor is smallest this month but biggest last month: only this month ranks.
    const amounts = [3000, 9000, 5000, 7000, 4000, 1000];

    for (const [i, member] of members.entries()) {
      await visit(programme.id, member.id, amounts[i], "2026-10-10T10:00:00Z");
    }

    await visit(programme.id, members[5].id, 900000, "2026-09-10T10:00:00Z");
    await visit(programme.id, gone.id, 800000, "2026-10-11T10:00:00Z");
    // A second visit adds to the same person.
    await visit(programme.id, members[0].id, 3500, "2026-10-12T10:00:00Z");

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.topClientsThisMonth).toEqual([
      { memberId: members[1].id, name: "Berta", amountCents: 9000 },
      { memberId: members[3].id, name: "Diana", amountCents: 7000 },
      { memberId: members[0].id, name: "Ana", amountCents: 6500 },
      { memberId: members[2].id, name: "Carla", amountCents: 5000 },
      { memberId: members[4].id, name: "Elena", amountCents: 4000 }
    ]);
  });
});

describe("clinicOverview: points issued this month", () => {
  const seedLedger = async (clinicId: string, memberId: string) => {
    await ledger(clinicId, memberId, 40, PointsTransactionKind.EARN, "2026-09-30T21:30:00Z"); // before
    await ledger(clinicId, memberId, 100, PointsTransactionKind.EARN, "2026-09-30T22:30:00Z"); // in
    await ledger(clinicId, memberId, 5, PointsTransactionKind.REFERRAL, "2026-10-05T10:00:00Z");
    await ledger(clinicId, memberId, 20, PointsTransactionKind.ADJUSTMENT, "2026-10-06T10:00:00Z");
    await ledger(clinicId, memberId, -7, PointsTransactionKind.ADJUSTMENT, "2026-10-07T10:00:00Z"); // claw-back
    await ledger(clinicId, memberId, -10, PointsTransactionKind.EXPIRY, "2026-10-08T10:00:00Z");
    await ledger(clinicId, memberId, -30, PointsTransactionKind.REDEEM, "2026-10-09T10:00:00Z");
    await ledger(clinicId, memberId, 60, PointsTransactionKind.EARN, "2026-10-31T23:30:00Z"); // after
  };

  it("counts credits only, in display units (x10) at a programme centre", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await seedLedger(programme.id, ana.id);

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    // 100 + 5 + 20 progress euros credited this month = 125, shown as 1250 points.
    expect(overview.pointsIssuedThisMonth).toBe(1250);
  });

  it("stays raw at a centre without a programme", async () => {
    const ana = await makeMember(legacy.id, "Ana");

    await seedLedger(legacy.id, ana.id);

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(legacy.id);

    expect(overview.pointsIssuedThisMonth).toBe(125);
    expect(overview.revenueThisMonthCents).toBe(0);
    expect(overview.moneySpentTotalCents).toBe(0);
  });

  it("is no longer the all-time euro revenue; that number has its own name", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await visit(programme.id, ana.id, 12345, "2025-01-10T10:00:00Z");

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.pointsIssuedThisMonth).toBe(0);
    expect(overview.revenueAllTimeCents).toBe(12345);
  });
});

describe("clinicOverview: rewards redeemed this month", () => {
  it("counts redeemed programme rewards by redeemedAt, in the Madrid month", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await reward(programme.id, ana.id, "2026-09-30T21:30:00Z"); // before
    await reward(programme.id, ana.id, "2026-09-30T22:30:00Z"); // in
    await reward(programme.id, ana.id, "2026-10-20T10:00:00Z"); // in
    await reward(programme.id, ana.id, "2026-10-31T23:30:00Z"); // after
    await reward(programme.id, ana.id, null); // issued, not redeemed
    // A double-points perk is spent automatically by a visit, not redeemed by anyone at the desk.
    await reward(programme.id, ana.id, "2026-10-12T10:00:00Z", { perk: "doble" });

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.rewardsRedeemedThisMonth).toBe(2);
  });

  it("counts ledger REDEEM rows at a centre without a programme", async () => {
    const ana = await makeMember(legacy.id, "Ana");

    await ledger(legacy.id, ana.id, -30, PointsTransactionKind.REDEEM, "2026-10-09T10:00:00Z");
    await ledger(legacy.id, ana.id, -30, PointsTransactionKind.REDEEM, "2026-10-10T10:00:00Z");
    await ledger(legacy.id, ana.id, -30, PointsTransactionKind.REDEEM, "2026-09-10T10:00:00Z");
    await ledger(legacy.id, ana.id, -5, PointsTransactionKind.EXPIRY, "2026-10-10T10:00:00Z");

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(legacy.id);

    expect(overview.rewardsRedeemedThisMonth).toBe(2);
  });
});

describe("clinicOverview: existing fields keep working", () => {
  it("still returns members, wallet adds and recent activity", async () => {
    const ana = await makeMember(programme.id, "Ana");

    await ledger(programme.id, ana.id, 10, PointsTransactionKind.EARN, "2026-10-10T10:00:00Z");
    await db.walletObject.create({
      data: {
        memberId: ana.id,
        provider: WalletProviderType.GOOGLE,
        externalObjectId: "dash-agg-object",
        status: "SYNCED"
      }
    });

    const overview = await serviceAt("2026-10-15T10:00:00Z").clinicOverview(programme.id);

    expect(overview.activeMembers).toBe(1);
    expect(overview.walletAdds).toBe(1);
    expect(overview.recentActivity).toHaveLength(1);
  });
});
