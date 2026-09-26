import { Prisma, PointsTransactionKind, type PrismaClient } from "@prisma/client";

import { ZERO_BALANCE, type PointsBalance } from "./points-balance";
import type {
  AppendResult,
  MemberPointsCache,
  PointsEntry,
  PointsLedgerRepository,
  SpendOutcome
} from "./points-ledger.repository";
import type { TierDefinition } from "./tier-engine";

/** Postgres unique violation, surfaced by Prisma as P2002. */
const UNIQUE_VIOLATION = "P2002";

/** Prisma's code for a transaction the database rolled back to preserve serialisability. */
const SERIALISATION_FAILURE = "P2034";

/**
 * Two concurrent redemptions for one member are exactly what Serializable is there to
 * catch, so a retry is expected rather than exceptional. Bounded, because a loop that
 * never gives up turns contention into an outage.
 */
const SPEND_ATTEMPTS = 3;

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

  async appendSpend(entry: PointsEntry): Promise<SpendOutcome> {
    for (let attempt = 1; attempt <= SPEND_ATTEMPTS; attempt += 1) {
      try {
        return await this.spendOnce(entry);
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === SERIALISATION_FAILURE &&
          attempt < SPEND_ATTEMPTS;

        if (!retryable) throw error;
      }
    }

    // Unreachable: the loop either returns or rethrows on the final attempt.
    throw new Error("appendSpend exhausted its attempts without resolving");
  }

  /**
   * The affordability check and the insert, as one atomic step.
   *
   * Serializable, not the default Read Committed. Under Read Committed two concurrent
   * redemptions for the same member both read a sufficient balance, both insert, and the
   * member ends up negative — the classic lost-update, and the idempotency key cannot
   * help because these are two genuinely different operations.
   */
  private spendOnce(entry: PointsEntry): Promise<SpendOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.pointsTransaction.aggregate({
          where: { memberId: entry.memberId },
          _sum: { points: true }
        });

        const spendable = current._sum.points ?? 0;

        // entry.points is negative, so this is "would this take them below zero?".
        if (spendable + entry.points < 0) {
          return { outcome: "insufficient", spendable } as const;
        }

        try {
          await tx.pointsTransaction.create({ data: entry });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === UNIQUE_VIOLATION
          ) {
            return { outcome: "duplicate" } as const;
          }

          throw error;
        }

        return { outcome: "applied" } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
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

/**
 * Writes the derived balance and tier back onto Member.
 *
 * Its own class because writing a cache is a different privilege from appending to an
 * immutable ledger, and nothing that holds this should be able to reach the ledger.
 */
export class PrismaMemberPointsCache implements MemberPointsCache {
  constructor(private readonly prisma: PrismaClient) {}

  async write(memberId: string, spendable: number, tierCode: string | null): Promise<void> {
    await this.prisma.member.update({
      where: { id: memberId },
      data: { pointsBalance: spendable, tier: tierCode }
    });
  }
}
