import { WalletProviderType, WalletSyncStatus, type PrismaClient } from "@prisma/client";

import { CLINIC_TIME_ZONE, startOfMonthIn } from "../../common/utils/zoned-month";
import { countsTowardsLifetime } from "../points/points-balance";

export interface DashboardOverview {
  activeMembers: number;
  pointsIssuedThisMonth: number;
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
    private readonly googlePublishing: () => "demo" | "live"
  ) {}

  async clinicOverview(clinicId: string, now: Date = new Date()): Promise<DashboardOverview> {
    const monthStart = startOfMonthIn(CLINIC_TIME_ZONE, now);

    const [activeMembers, issued, walletAdds, recent] = await Promise.all([
      this.prisma.member.count({ where: { clinicId, erasedAt: null } }),

      // Positive movements only, and only the kinds that represent points actually
      // granted — the same rule as lifetime. A redemption is not negative issuance, and
      // a clawback should reduce the figure rather than be counted as an issue.
      this.prisma.pointsTransaction.aggregate({
        where: {
          clinicId,
          createdAt: { gte: monthStart },
          kind: { in: this.issuingKinds() }
        },
        _sum: { points: true }
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
      })
    ]);

    return {
      activeMembers,
      pointsIssuedThisMonth: issued._sum.points ?? 0,
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

  private issuingKinds() {
    return (["EARN", "REFERRAL", "ADJUSTMENT"] as const).filter((kind) =>
      countsTowardsLifetime(kind)
    );
  }
}
