import { PointsTransactionKind } from "@prisma/client";

/**
 * The two balances a loyalty programme needs, and why one integer cannot carry both.
 *
 * SPENDABLE is what a member may redeem: every movement summed, earns and spends alike.
 * LIFETIME is what they have ever legitimately earned, and it is what drives their tier.
 *
 * Keeping them separate is not bookkeeping neatness. With a single counter, redeeming a
 * reward reduces the number that determines your tier, so spending points demotes you —
 * the programme punishes exactly the behaviour it exists to encourage. A member who
 * reaches Gold and then uses it does not stop being a Gold member.
 */

/** The fields of a ledger row a balance depends on. Nothing else is relevant here. */
export interface PointsMovement {
  points: number;
  kind: PointsTransactionKind;
}

export interface PointsBalance {
  /** Sum of every movement. */
  spendable: number;
  /** What the member has earned and kept the credit for. Drives the tier. */
  lifetime: number;
}

export const ZERO_BALANCE: PointsBalance = { spendable: 0, lifetime: 0 };

/**
 * The kinds that count towards lifetime, and therefore towards tier.
 *
 * The rule is "everything you earned, less anything that was taken back because it
 * should never have been granted".
 *
 * - EARN and REFERRAL are earnings. Obviously in.
 * - ADJUSTMENT is signed and in, which is the subtle one. A staff member who credits
 *   1,000,000 points by mistake must be able to undo it. If lifetime counted only
 *   positive movements, the correction would restore the spendable balance and leave
 *   the member permanently at the top tier, standing on points that no longer exist.
 * - REDEEM is out. Spending a reward must never demote anyone; that is the entire
 *   reason these two balances are separate.
 * - EXPIRY is out. Lapsed points stop being spendable, but the member did earn them,
 *   and a tier is a record of what they achieved rather than of what they still hold.
 */
const LIFETIME_KINDS: ReadonlySet<PointsTransactionKind> = new Set([
  PointsTransactionKind.EARN,
  PointsTransactionKind.REFERRAL,
  PointsTransactionKind.ADJUSTMENT
]);

export const countsTowardsLifetime = (kind: PointsTransactionKind): boolean =>
  LIFETIME_KINDS.has(kind);

/**
 * Projects a member's balance from their ledger.
 *
 * Order-independent by construction: it is a sum, so a replay in any order gives the same
 * answer. That is what makes the cached columns on Member safe to recompute at any time,
 * including halfway through a backfill.
 */
export const projectBalance = (movements: readonly PointsMovement[]): PointsBalance =>
  movements.reduce<PointsBalance>(
    (balance, movement) => ({
      spendable: balance.spendable + movement.points,
      lifetime: balance.lifetime + (countsTowardsLifetime(movement.kind) ? movement.points : 0)
    }),
    ZERO_BALANCE
  );
