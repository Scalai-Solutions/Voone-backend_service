import type { PointsTransactionKind } from "@prisma/client";

import type { PointsBalance } from "./points-balance";
import type { TierDefinition } from "./tier-engine";

/** A row to append. There is no update or delete counterpart, by design. */
export interface PointsEntry {
  memberId: string;
  clinicId: string;
  /** Signed. The database rejects a sign that disagrees with the kind. */
  points: number;
  kind: PointsTransactionKind;
  reason?: string;
  sourceRef?: string;
  /**
   * Minted from the operation, not from the member. A retry of the same operation
   * carries the same key and must not move points a second time.
   */
  idempotencyKey: string;
  /** Staff user, absent for system-generated rows. */
  createdBy?: string;
}

export interface AppendResult {
  /**
   * False when this exact operation had already been recorded.
   *
   * Not an error: a retried request, a double tap at reception, or a redelivered queue
   * job all reach here legitimately, and the correct outcome is the one that already
   * happened. Callers that treat it as a failure will show a member an error for an
   * action that worked.
   */
  applied: boolean;
}

/**
 * Reads and appends to the points ledger.
 *
 * Deliberately has no update or delete method. The absence is the contract: nothing can
 * rewrite history through this port, so every balance stays reproducible from the rows.
 */
export interface PointsLedgerRepository {
  /** Appends one movement, or reports that its idempotency key was already used. */
  append(entry: PointsEntry): Promise<AppendResult>;

  /**
   * The member's balance, computed in the database rather than by loading their history.
   *
   * A member with years of visits should not cost a full table read to render a card.
   */
  balanceFor(memberId: string): Promise<PointsBalance>;

  /**
   * The tier scale that applies to a clinic: its own rows where it has them, the global
   * defaults otherwise. Never a mixture — a clinic that defines any tiers defines all of
   * them, because merging two partial scales silently produces a third scale nobody
   * wrote.
   */
  tierScaleFor(clinicId: string): Promise<TierDefinition[]>;
}
