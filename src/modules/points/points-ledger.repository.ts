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
/**
 * Why a spend did or did not happen.
 *
 * "insufficient" is a first-class outcome rather than an exception because it is an
 * ordinary thing for a member to try: it is not exceptional that someone at reception
 * asks to redeem a reward they cannot quite afford yet.
 */
export type SpendOutcome =
  | { outcome: "applied" }
  | { outcome: "duplicate" }
  | { outcome: "insufficient"; spendable: number };

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

  /**
   * Appends a spend only if the member can currently afford it — atomically.
   *
   * The affordability check and the insert MUST be one atomic step, which is why this
   * is a repository concern rather than a service one. Checking the balance and then
   * inserting races: two staff members redeeming the same reward for the same member at
   * the same moment both read a sufficient balance, both insert, and the member goes
   * negative. The idempotency key does not help, because these are two genuinely
   * different operations.
   */
  appendSpend(entry: PointsEntry): Promise<SpendOutcome>;
}

/**
 * The cached balance and tier on Member.
 *
 * A cache, not a source of truth: every value here is derivable from the ledger, and
 * exists only because rendering a wallet pass must not sum a member's whole history.
 * Separate from the ledger port because writing a cache is a different privilege from
 * appending to an immutable record.
 */
export interface MemberPointsCache {
  write(memberId: string, spendable: number, tierCode: string | null): Promise<void>;
}
