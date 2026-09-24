import { Prisma, PointsTransactionKind, type PrismaClient } from "@prisma/client";

import { ZERO_BALANCE, type PointsBalance } from "./points-balance";
import type { AppendResult, PointsEntry, PointsLedgerRepository } from "./points-ledger.repository";
import type { TierDefinition } from "./tier-engine";

/** Postgres unique violation, surfaced by Prisma as P2002. */
const UNIQUE_VIOLATION = "P2002";

/** Mirrors countsTowardsLifetime, expressed as a Prisma filter. */
const LIFETIME_KINDS = [
  PointsTransactionKind.EARN,
  PointsTransactionKind.REFERRAL,
  PointsTransactionKind.ADJUSTMENT
];

export class PrismaPointsLedgerRepository implements PointsLedgerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: PointsEntry): Promise<AppendResult> {
    try {
      await this.prisma.pointsTransaction.create({ data: entry });

      return { applied: true };
    } catch (error) {
      // The unique index on idempotencyKey IS the double-redemption guard. Catching the
      // violation rather than checking first is deliberate: a read-then-write races, and
      // two concurrent redemptions of the same reward are exactly the case that matters.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        return { applied: false };
      }

      throw error;
    }
  }

  async balanceFor(memberId: string): Promise<PointsBalance> {
    // Two aggregates rather than loading the history: a long-standing member's ledger
    // should not be read in full to render one card.
    //
    // Lifetime filters by KIND, not by sign. Summing the positive rows would mean a
    // mistaken credit could be undone for spending but never for tier, leaving the
    // member at a level they were never entitled to. See countsTowardsLifetime.
    const [all, earned] = await Promise.all([
      this.prisma.pointsTransaction.aggregate({
        where: { memberId },
        _sum: { points: true }
      }),
      this.prisma.pointsTransaction.aggregate({
        where: { memberId, kind: { in: LIFETIME_KINDS } },
        _sum: { points: true }
      })
    ]);

    return {
      spendable: all._sum.points ?? ZERO_BALANCE.spendable,
      lifetime: earned._sum.points ?? ZERO_BALANCE.lifetime
    };
  }

  async tierScaleFor(clinicId: string): Promise<TierDefinition[]> {
    const own = await this.read({ clinicId });

    // All of a clinic's tiers or none of them. Merging a partial clinic scale over the
    // global one would produce a third scale that nobody authored and nobody could
    // predict from either source.
    if (own.length > 0) return own;

    return this.read({ clinicId: null });
  }

  private async read(where: { clinicId: string | null }): Promise<TierDefinition[]> {
    const rows = await this.prisma.tierThreshold.findMany({
      where,
      orderBy: { minLifetimePoints: "asc" },
      select: { code: true, label: true, minLifetimePoints: true }
    });

    return rows;
  }
}
