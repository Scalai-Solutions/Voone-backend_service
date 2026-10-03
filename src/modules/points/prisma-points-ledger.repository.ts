import { Prisma, PointsTransactionKind, type PrismaClient } from "@prisma/client";

import { ZERO_BALANCE, type PointsBalance } from "./points-balance";
import type {
  AppendResult,
  MemberPointsCache,
  PointsEntry,
  PointsLedgerRepository,
  SpendOutcome
} from "./points-ledger.repository";
import { tierRewardsSchema } from "../templates/templates.schema";
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

  /**
   * The tiers the clinic authored during onboarding.
   *
   * Read from ClinicTemplate.tierRewards rather than a table of its own. There used to
   * be both: a TierThreshold table this method queried, and the tierRewards JSON the
   * wizard actually writes. The table was never populated by anything, so every card
   * showed no tier while the wizard appeared to have configured five — two models of
   * one concept, neither able to rank a member.
   *
   * One source now, and it is the one a clinic edits. A scale is at most twenty rows
   * and the template is already loaded wherever a card is built, so a separate indexed
   * table bought nothing and cost a synchronisation path — which is exactly what
   * produced the other duplications this month.
   */
  async tierScaleFor(clinicId: string): Promise<TierDefinition[]> {
    const template = await this.prisma.clinicTemplate.findUnique({
      where: { clinicId },
      select: { tierRewards: true }
    });

    const parsed = tierRewardsSchema.safeParse(template?.tierRewards ?? []);

    if (!parsed.success) {
      // A template authored before tiers carried points, or hand-edited into something
      // unusable. Reported and treated as no scale: putting a member in a tier derived
      // from a scale we could not read would be worse than showing none.
      console.warn(`[points] clinic ${clinicId} has an unreadable tier scale; no tier applied.`);

      return [];
    }

    return parsed.data.map((tier) => ({
      // The name is the code: it is what the clinic typed, what the pass shows, and
      // there is no second identifier for a clinic owner to keep in step.
      code: tier.name,
      label: tier.name,
      minLifetimePoints: tier.minLifetimePoints,
      milestoneCount: tier.milestoneCount,
      pointsToNextMilestone: tier.pointsToNextMilestone
    }));
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
}

/**
 * Writes the derived balance and tier back onto Member.
 *
 * Its own class because writing a cache is a different privilege from appending to an
 * immutable ledger, and nothing that holds this should be able to reach the ledger.
 */
export class PrismaMemberPointsCache implements MemberPointsCache {
  constructor(private readonly prisma: PrismaClient) {}

  async read(memberId: string): Promise<{ tier: string | null; lifetimePoints: number } | null> {
    return this.prisma.member.findUnique({
      where: { id: memberId },
      select: { tier: true, lifetimePoints: true }
    });
  }

  async write(
    memberId: string,
    balance: { spendable: number; lifetime: number },
    tierCode: string | null
  ): Promise<void> {
    await this.prisma.member.update({
      where: { id: memberId },
      // All three together: a pass reads the balance, the tier and the milestone
      // rhythm in one go, and writing them separately would let a card render a tier
      // the lifetime total does not justify.
      data: {
        pointsBalance: balance.spendable,
        lifetimePoints: balance.lifetime,
        tier: tierCode
      }
    });
  }
}
