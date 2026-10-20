import { PointsTransactionKind } from "@prisma/client";

import { InsufficientPointsError } from "../../common/errors/points.errors";
import type { WalletSyncQueue } from "../../wallet/engine/wallet-sync.queue";
import type { PointsBalance } from "./points-balance";
import type {
  MemberPointsCache,
  PointsEntry,
  PointsLedgerRepository
} from "./points-ledger.repository";
import { tierFor, type TierDefinition } from "./tier-engine";

/** Kinds that add points. Separated so a caller cannot credit with a REDEEM. */
export type CreditKind =
  | typeof PointsTransactionKind.EARN
  | typeof PointsTransactionKind.REFERRAL
  | typeof PointsTransactionKind.ADJUSTMENT;

export interface CreditRequest {
  memberId: string;
  clinicId: string;
  /** Always positive. The service applies the sign, so no caller can get it wrong. */
  points: number;
  kind: CreditKind;
  reason?: string;
  sourceRef?: string;
  idempotencyKey: string;
  createdBy?: string;
}

export interface RedeemRequest {
  memberId: string;
  clinicId: string;
  /** Always positive: how much to spend. */
  points: number;
  reason?: string;
  sourceRef?: string;
  idempotencyKey: string;
  createdBy?: string;
}

export interface PointsOutcome {
  /**
   * False when this exact operation had already been recorded. Not an error — the
   * correct result is the one that already happened.
   */
  applied: boolean;
  balance: PointsBalance;
  tier: TierDefinition | null;
}

export interface PointsNotificationPort {
  onPointsCredited(
    memberId: string,
    newBalance: number,
    flags: { milestoneReached: boolean; tierChanged: boolean }
  ): Promise<void>;
}

/**
 * What a published onboarding programme contributes to a tier decision.
 *
 * A legacy clinic ranks members on lifetime points alone. A clinic with a published
 * programme must also respect a minimum tenure per tier, never take a tier away, and notify
 * on its real milestones rather than on evenly spaced ones. None of that belongs in the
 * points module, which should not know programmes exist — so it asks this port, and a
 * clinic without a programme gets `null` and the legacy rules, unchanged.
 */
export interface ProgramTierPort {
  resolve(input: {
    memberId: string;
    clinicId: string;
    lifetime: number;
    /** The tier the member holds now, as stored. */
    current: string | null;
    /** Only a staff correction may take a tier away. */
    allowDemotion: boolean;
  }): Promise<{
    tier: TierDefinition;
    /** Whether going from `before` to `after` crossed a milestone worth announcing. */
    milestoneCrossed: (before: number, after: number) => boolean;
  } | null>;
}

/** Re-exported so callers of the service need not know where the error is declared. */
export { InsufficientPointsError };

const assertPositive = (points: number): void => {
  if (!Number.isInteger(points) || points <= 0) {
    // A fractional or negative amount reaching the ledger would be caught by the
    // database CHECK, but as a 500. Rejecting here makes it a bad request.
    throw new RangeError(`points must be a positive integer, got ${points}`);
  }
};

/**
 * Credits and redemptions, and the three things that must happen around them.
 *
 * Every movement goes through here rather than through the repository, because an append
 * on its own leaves the system inconsistent: the cached balance on Member is stale, the
 * tier may have changed, and the member's wallet still shows the old number.
 */
export class PointsService {
  constructor(
    private readonly ledger: PointsLedgerRepository,
    private readonly cache: MemberPointsCache,
    private readonly wallets: WalletSyncQueue,
    private readonly notifications?: PointsNotificationPort,
    private readonly programTiers?: ProgramTierPort
  ) {}

  /** The member's balances, from the ledger. For callers that need a number before they act. */
  balanceFor(memberId: string): Promise<PointsBalance> {
    return this.ledger.balanceFor(memberId);
  }

  async credit(request: CreditRequest): Promise<PointsOutcome> {
    assertPositive(request.points);

    const entry: PointsEntry = {
      memberId: request.memberId,
      clinicId: request.clinicId,
      points: request.points,
      kind: request.kind,
      reason: request.reason,
      sourceRef: request.sourceRef,
      idempotencyKey: request.idempotencyKey,
      createdBy: request.createdBy
    };

    const { applied } = await this.ledger.append(entry);

    return this.settle(request.memberId, request.clinicId, applied);
  }

  /**
   * Takes points back, for a correction rather than a purchase.
   *
   * Separate from redeem because the two mean different things and land on different
   * kinds: a clawback reduces the lifetime total and therefore the tier, a redemption
   * never does. Collapsing them would silently make every refund a demotion, or every
   * redemption fail to undo a mistake.
   */
  async clawBack(request: Omit<CreditRequest, "kind">): Promise<PointsOutcome> {
    assertPositive(request.points);

    const { applied } = await this.ledger.append({
      memberId: request.memberId,
      clinicId: request.clinicId,
      points: -request.points,
      kind: PointsTransactionKind.ADJUSTMENT,
      reason: request.reason,
      sourceRef: request.sourceRef,
      idempotencyKey: request.idempotencyKey,
      createdBy: request.createdBy
    });

    // A correction is the one thing allowed to take a tier away: the guide says tiers are
    // not lost, but a wrong credit must be undoable for tier as well as for balance.
    return this.settle(request.memberId, request.clinicId, applied, true);
  }

  async redeem(request: RedeemRequest): Promise<PointsOutcome> {
    assertPositive(request.points);

    const result = await this.ledger.appendSpend({
      memberId: request.memberId,
      clinicId: request.clinicId,
      // Negative, applied here so no caller can pass the wrong sign.
      points: -request.points,
      kind: PointsTransactionKind.REDEEM,
      reason: request.reason,
      sourceRef: request.sourceRef,
      idempotencyKey: request.idempotencyKey,
      createdBy: request.createdBy
    });

    if (result.outcome === "insufficient") {
      throw new InsufficientPointsError(request.points, result.spendable);
    }

    return this.settle(request.memberId, request.clinicId, result.outcome === "applied");
  }

  /**
   * Recomputes the cache and asks the wallets to catch up.
   *
   * Runs even when the movement was a duplicate. A retry usually means the first attempt
   * did not visibly finish, and the most likely reason is that this step failed — so
   * repeating it is how a member whose card is stuck on an old balance gets unstuck.
   * Both operations are idempotent, so doing it twice costs nothing.
   *
   * Deliberately NOT in a transaction with the append. The ledger is the source of
   * truth and the cache is derivable from it, so a crash here leaves a stale number
   * that a recompute fixes — whereas holding a transaction open across a queue call
   * would put a wallet vendor's latency inside a database lock.
   */
  private async settle(
    memberId: string,
    clinicId: string,
    applied: boolean,
    allowDemotion = false
  ): Promise<PointsOutcome> {
    const [balance, scale] = await Promise.all([
      this.ledger.balanceFor(memberId),
      this.ledger.tierScaleFor(clinicId)
    ]);
    // Read for a programme even on a duplicate: "never lose a tier" needs the tier held now,
    // and a retry is exactly when it might not be the one the cache last wrote.
    const previous =
      (applied || this.programTiers) && this.cache.read ? await this.cache.read(memberId) : null;

    const program = this.programTiers
      ? await this.programTiers.resolve({
          memberId,
          clinicId,
          lifetime: balance.lifetime,
          current: previous?.tier ?? null,
          allowDemotion
        })
      : null;

    const tier = program ? program.tier : tierFor(balance.lifetime, scale);

    await this.cache.write(memberId, balance, tier?.code ?? null, { allowDecrease: allowDemotion });

    // Never awaited for its result and never allowed to throw: the member is standing at
    // reception, and a wallet outage must not look like a failed transaction.
    await this.wallets.enqueueMemberSync(memberId);

    if (applied && this.notifications) {
      this.notifications
        .onPointsCredited(memberId, balance.spendable, {
          milestoneReached: previous
            ? program
              ? program.milestoneCrossed(previous.lifetimePoints, balance.lifetime)
              : this.crossedMilestone(previous.lifetimePoints, balance.lifetime, tier)
            : false,
          tierChanged: previous ? previous.tier !== (tier?.code ?? null) : false
        })
        .catch((error) => {
          console.error("[notifications] could not enqueue points credit notification", {
            memberId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }

    return { applied, balance, tier };
  }

  private crossedMilestone(
    previousLifetime: number,
    nextLifetime: number,
    tier: TierDefinition | null
  ): boolean {
    if (!tier?.milestoneCount || !tier.pointsToNextMilestone) return false;

    const step = Math.max(1, Math.trunc(tier.pointsToNextMilestone));
    const total = Math.max(1, Math.trunc(tier.milestoneCount));
    const progress = (lifetime: number) =>
      Math.min(total, Math.floor(Math.max(0, lifetime - tier.minLifetimePoints) / step));

    return progress(nextLifetime) > progress(previousLifetime);
  }
}
