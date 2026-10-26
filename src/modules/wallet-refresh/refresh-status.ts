import { Prisma, WalletSyncStatus } from "@prisma/client";

import { prisma } from "../../infrastructure/database/prisma-client";

/**
 * Whether the last card-design change has reached a clinic's cards.
 *
 * `refreshClinicCards` queues one sync per member and answers with how many it queued, not how
 * many worked. This is the other half: the dashboard reads it to say "x of y cards updated".
 *
 * Everything here counts MEMBERS, one card each, however many wallets (Apple, Google) that
 * member holds. A member with two passes is one card, so synced + failed never exceeds eligible.
 */
export interface RefreshStatus {
  /** Members who hold a wallet pass now: the cards a refresh can reach. */
  eligible: number;
  /** The clinic's newest recorded design change, or null when none has been recorded. */
  lastChange: { at: string; by: string | null; cardsAtSave: number } | null;
  /** Members whose every pass synced at or after the last change. */
  syncedSince: number;
  /** Members with at least one pass whose last sync failed. Never also counted as synced. */
  failedSince: number;
}

/**
 * `db` is the Prisma client, or a transaction of it when the caller wants the reads kept in
 * one snapshot (tests use it to roll back).
 */
export const getRefreshStatus = async (
  clinicId: string,
  db: Pick<Prisma.TransactionClient, "member" | "templateChange"> = prisma
): Promise<RefreshStatus> => {
  const holders = { clinicId, erasedAt: null };
  const [eligible, change] = await Promise.all([
    db.member.count({ where: { ...holders, walletObjects: { some: {} } } }),
    db.templateChange.findFirst({
      where: { clinicId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, changedBy: true, cardsAtSave: true }
    })
  ]);

  if (!change) return { eligible, lastChange: null, syncedSince: 0, failedSince: 0 };

  const [syncedSince, failedSince] = await Promise.all([
    // Every pass current, and at least one pass (`every` is true for none). A member with one
    // synced and one failed or older pass has not received the change on every device.
    db.member.count({
      where: {
        ...holders,
        walletObjects: {
          some: {},
          every: { status: WalletSyncStatus.SYNCED, lastSyncedAt: { gte: change.createdAt } }
        }
      }
    }),
    // WalletObject has no updatedAt, and a failed sync deliberately leaves lastSyncedAt on the
    // last state a device received (see markFailed), so a failure has no timestamp of its own
    // and filtering FAILED rows by lastSyncedAt would drop exactly the ones that failed after
    // the change. Every refresh re-queues every card, so a pass still FAILED is the outcome of
    // the latest attempt; it is counted whatever date the pass last synced. A member with a
    // failed pass cannot satisfy the synced rule above, so no member is in both counts.
    db.member.count({
      where: { ...holders, walletObjects: { some: { status: WalletSyncStatus.FAILED } } }
    })
  ]);

  return {
    eligible,
    lastChange: {
      at: change.createdAt.toISOString(),
      by: change.changedBy,
      cardsAtSave: change.cardsAtSave
    },
    syncedSince,
    failedSince
  };
};
