import { PointsTransactionKind } from "@prisma/client";

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

/** A member tried to spend more than they have. Ordinary, not exceptional. */
export class InsufficientPointsError extends Error {
  constructor(
    readonly requested: number,
    readonly spendable: number
  ) {
    super(`cannot redeem ${requested} points: member has ${spendable}`);
    this.name = "InsufficientPointsError";
  }
}

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
    private readonly wallets: WalletSyncQueue
  ) {}

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

    return this.settle(request.memberId, request.clinicId, applied);
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
    applied: boolean
  ): Promise<PointsOutcome> {
    const [balance, scale] = await Promise.all([
      this.ledger.balanceFor(memberId),
      this.ledger.tierScaleFor(clinicId)
    ]);

    const tier = tierFor(balance.lifetime, scale);

    await this.cache.write(memberId, balance.spendable, tier?.code ?? null);

    // Never awaited for its result and never allowed to throw: the member is standing at
    // reception, and a wallet outage must not look like a failed transaction.
    await this.wallets.enqueueMemberSync(memberId);

    return { applied, balance, tier };
  }
}
