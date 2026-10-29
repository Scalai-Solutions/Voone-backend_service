import {
  PointsTransactionKind,
  WalletProviderType,
  WalletSyncStatus,
  type PrismaClient
} from "@prisma/client";

import {
  CLINIC_TIME_ZONE,
  startOfMonthIn,
  startOfNextMonthIn
} from "../../common/utils/zoned-month";
import { isProgrammeCentre, toPoints } from "../onboarding/runtime/points-unit";
import { isDoublePointsPerk } from "../onboarding/runtime/rules";

export interface TopClient {
  memberId: string;
  name: string;
  amountCents: number;
}

export interface DashboardOverview {
  activeMembers: number;
  /**
   * Points credited this month, in the unit every screen shows: ten per euro of progress at a
   * programme centre, the ledger's own figure elsewhere.
   *
   * CHANGED MEANING. This field used to hold the ALL-TIME sum of paid euros (see
   * revenueAllTimeCents). The frontend must stop reading it as euros.
   */
  pointsIssuedThisMonth: number;
  /**
   * Euros that earned progress this month, in cents (Europe/Madrid calendar month). It is the
   * sum of PaidVisit.amountCents, which holds what EARNS progress rather than the till total:
   * pharmacological medicine and medical acts earn nothing and are NOT included; retail
   * cosmetics are; a bono session counts its price divided by its sessions. No split is
   * invented for money that was never recorded.
   */
  revenueThisMonthCents: number;
  /** The old `pointsIssuedThisMonth` figure, honestly named: all time, same source, in cents. */
  revenueAllTimeCents: number;
  /** Real euros recorded through visits, all time, in cents. Same source as revenueAllTimeCents. */
  moneySpentTotalCents: number;
  /**
   * Rewards redeemed this month: programme rewards by MemberReward.redeemedAt (not counting a
   * double-points perk, which a visit spends automatically) plus ledger REDEEM rows (what a centre
   * without a programme records). A centre never has both for the same redemption, so summing
   * cannot double count.
   */
  rewardsRedeemedThisMonth: number;
  /** The five clients who paid the most this month, biggest first. Erased members are left out. */
  topClientsThisMonth: TopClient[];
  walletAdds: number;
  recentActivity: Array<{ id: string; label: string; date: string }>;
}

export interface WalletInfrastructure {
  /** ISO date. Empty when no certificate is configured — see appleEnabled. */
  appleCertificateExpiresAt: string;
  appleEnabled: boolean;
  googlePublishingStatus: "demo" | "live";
  recentErrors: Array<{ provider: "apple" | "google"; count: number; label: string }>;
}

export interface PlatformOverview {
  totalClinics: number;
  totalMembers: number;
  wallet: WalletInfrastructure;
}

const RECENT_ACTIVITY = 10;
const TOP_CLIENTS = 5;

/**
 * Ledger kinds that are a credit when positive. A negative ADJUSTMENT is a claw-back and is
 * never counted; EXPIRY and REDEEM only ever subtract.
 */
const CREDIT_KINDS = [
  PointsTransactionKind.EARN,
  PointsTransactionKind.REFERRAL,
  PointsTransactionKind.ADJUSTMENT
];

/**
 * The numbers the clinic dashboard and the Voone admin panel show.
 *
 * Every one of these was fabricated by the frontend until now: the pages call endpoints
 * that did not exist, and withMockFallback substituted invented figures on 404. They are
 * computable at all because the points ledger exists — before it, there was genuinely
 * nothing to count.
 */
export class DashboardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly certificate: () => { expiresAt: Date | null; enabled: boolean },
    private readonly googlePublishing: () => "demo" | "live",
    private readonly now: () => Date = () => new Date()
  ) {}

  async clinicOverview(clinicId: string): Promise<DashboardOverview> {
    // The clinic's calendar month, in Madrid: [start, end).
    const at = this.now();
    const monthStart = startOfMonthIn(CLINIC_TIME_ZONE, at);
    const monthEnd = startOfNextMonthIn(CLINIC_TIME_ZONE, at);
    const inMonth = { gte: monthStart, lt: monthEnd };

    const [
      activeMembers,
      revenueAllTime,
      revenueMonth,
      walletAdds,
      recent,
      credited,
      redeemedProgramme,
      ledgerRedeemed,
      topSpenders,
      programme
    ] = await Promise.all([
      this.prisma.member.count({ where: { clinicId, erasedAt: null } }),

      this.prisma.paidVisit.aggregate({
        where: { clinicId },
        _sum: { amountCents: true }
      }),

      this.prisma.paidVisit.aggregate({
        where: { clinicId, occurredAt: inMonth },
        _sum: { amountCents: true }
      }),

      // Cards that reached the provider. PENDING is issued-but-unconfirmed and counting
      // it would overstate adoption, which is the one number nobody should flatter.
      this.prisma.walletObject.count({
        where: { status: WalletSyncStatus.SYNCED, member: { clinicId } }
      }),

      this.prisma.pointsTransaction.findMany({
        where: { clinicId },
        orderBy: { createdAt: "desc" },
        take: RECENT_ACTIVITY,
        select: { id: true, reason: true, kind: true, createdAt: true }
      }),

      // Points credited this month: positive EARN (visits, with any staff bonus already
      // inside the row), REFERRAL (welcome credit) and ADJUSTMENT rows. Claw-backs (negative
      // ADJUSTMENT), EXPIRY and REDEEM are subtractions and never counted.
      this.prisma.pointsTransaction.aggregate({
        where: { clinicId, kind: { in: CREDIT_KINDS }, points: { gt: 0 }, createdAt: inMonth },
        _sum: { points: true }
      }),

      // A double-points perk gets a redeemedAt too, when the next visit uses it up. That is the
      // visit spending it, not a reward handed over at the desk, so it is not counted (the card
      // makes the same distinction: it is "not a gift"). Filtered here, with the same predicate
      // the card uses, because a SQL NOT over a JSON path drops rows whose detail has no path.
      this.prisma.memberReward.findMany({
        where: { clinicId, redeemedAt: inMonth },
        select: { kind: true, detail: true }
      }),

      this.prisma.pointsTransaction.count({
        where: { clinicId, kind: PointsTransactionKind.REDEEM, createdAt: inMonth }
      }),

      // Ties break on the member id so the order is stable between two requests.
      this.prisma.paidVisit.groupBy({
        by: ["memberId"],
        where: { clinicId, occurredAt: inMonth, member: { erasedAt: null } },
        _sum: { amountCents: true },
        having: { amountCents: { _sum: { gt: 0 } } },
        orderBy: [{ _sum: { amountCents: "desc" } }, { memberId: "asc" }],
        take: TOP_CLIENTS
      }),

      isProgrammeCentre(this.prisma, clinicId)
    ]);

    const names = new Map(
      (
        await this.prisma.member.findMany({
          where: { id: { in: topSpenders.map((row) => row.memberId) } },
          select: { id: true, name: true }
        })
      ).map((member) => [member.id, member.name])
    );

    const programmeRedeemed = redeemedProgramme.filter(
      (row) => !isDoublePointsPerk(row.kind, row.detail)
    ).length;
    const creditedProgress = credited._sum.points ?? 0;
    const allTimeCents = revenueAllTime._sum.amountCents ?? 0;

    return {
      activeMembers,
      // The ledger holds euro progress at a programme centre; every screen shows it x10.
      pointsIssuedThisMonth: programme ? toPoints(creditedProgress) : creditedProgress,
      revenueThisMonthCents: revenueMonth._sum.amountCents ?? 0,
      revenueAllTimeCents: allTimeCents,
      moneySpentTotalCents: allTimeCents,
      rewardsRedeemedThisMonth: programmeRedeemed + ledgerRedeemed,
      topClientsThisMonth: topSpenders.map((row) => ({
        memberId: row.memberId,
        name: names.get(row.memberId) ?? "",
        amountCents: row._sum.amountCents ?? 0
      })),
      walletAdds,
      recentActivity: recent.map((row) => ({
        id: row.id,
        // Staff-authored reason where there is one, the kind otherwise. Never a treatment
        // name — the ledger does not hold them.
        label: row.reason ?? row.kind,
        date: row.createdAt.toISOString().slice(0, 10)
      }))
    };
  }

  async platformOverview(): Promise<PlatformOverview> {
    const [totalClinics, totalMembers, wallet] = await Promise.all([
      this.prisma.clinic.count({ where: { isActive: true } }),
      this.prisma.member.count({ where: { erasedAt: null } }),
      this.walletInfrastructure()
    ]);

    return { totalClinics, totalMembers, wallet };
  }

  async walletInfrastructure(): Promise<WalletInfrastructure> {
    const { expiresAt, enabled } = this.certificate();

    const failures = await this.prisma.walletObject.groupBy({
      by: ["provider"],
      where: { status: WalletSyncStatus.FAILED },
      _count: { _all: true }
    });

    return {
      appleCertificateExpiresAt: expiresAt ? expiresAt.toISOString() : "",
      appleEnabled: enabled,
      googlePublishingStatus: this.googlePublishing(),
      recentErrors: failures.map((row) => ({
        provider: row.provider === WalletProviderType.APPLE ? "apple" : "google",
        count: row._count._all,
        // WalletObject records a status, not a message, so there is no error text to
        // report. Inventing one would be worse than naming the state plainly.
        label: "Sincronización fallida"
      }))
    };
  }
}
