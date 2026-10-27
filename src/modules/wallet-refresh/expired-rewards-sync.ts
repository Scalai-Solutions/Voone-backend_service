import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../infrastructure/database/prisma-client";
import type { WalletSyncQueue } from "../../wallet/engine/wallet-sync.queue";
import { enqueueInBatches, walletQueue } from "./clinic-card-refresh";

/**
 * Takes expired rewards off members' cards.
 *
 * A reward lapses by the clock, not by anything that happens to the member, so no event fires and
 * the card keeps listing it. The daily tick asks for one card sync for every member who has a
 * reward that expired since the last tick; the assembler drops expired rewards, so the sync is
 * all it takes.
 *
 * 26 hours rather than 24: consecutive ticks overlap by two hours, so a tick that ran late, or a
 * restart across it, cannot leave a gap. A member picked up twice costs one idempotent sync.
 */

export const EXPIRED_REWARDS_LOOKBACK_HOURS = 26;

/** A run is bounded; the overlap above and the next day's tick pick up anything left. */
export const EXPIRED_REWARDS_MAX_MEMBERS = 500;

export interface ExpiredRewardsSyncOptions {
  prisma?: PrismaClient;
  syncQueue?: WalletSyncQueue | null;
  now?: () => Date;
}

/** Returns how many members were queued. Never throws: it must not take the cron down. */
export const syncMembersWithExpiredRewards = async ({
  prisma = defaultPrisma,
  syncQueue = walletQueue(),
  now = () => new Date()
}: ExpiredRewardsSyncOptions = {}): Promise<number> => {
  if (!syncQueue) return 0;

  try {
    const until = now();
    const since = new Date(until.getTime() - EXPIRED_REWARDS_LOOKBACK_HOURS * 3_600_000);
    const rows = await prisma.memberReward.findMany({
      where: {
        redeemedAt: null,
        expiresAt: { gt: since, lte: until },
        member: { erasedAt: null }
      },
      distinct: ["memberId"],
      select: { memberId: true },
      orderBy: { memberId: "asc" },
      take: EXPIRED_REWARDS_MAX_MEMBERS
    });

    await enqueueInBatches(
      syncQueue,
      rows.map((row) => row.memberId)
    );

    // The count only: no member is named in a log line.
    console.info("[wallet] queued card syncs for expired rewards", { members: rows.length });

    return rows.length;
  } catch (error) {
    console.error("[wallet] expired-rewards card sync failed", {
      error: error instanceof Error ? error.name : "unknown"
    });

    return 0;
  }
};
