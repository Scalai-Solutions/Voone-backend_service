import { prisma } from "../../infrastructure/database/prisma-client";
import type { WalletSyncQueue } from "../../wallet/engine/wallet-sync.queue";
import { buildWalletSyncQueue } from "../../wallet/wallet.composition";

/**
 * Brings every installed card of a clinic up to date with its template and programme.
 *
 * Saving a template updates the Google class, which Google fans out itself, but an Apple pass is
 * a file on each phone and a Google object carries per-member text. Both are rebuilt by the
 * member sync, so a design change reaches existing members by asking for one sync per member.
 */

const BATCH = 25;
const PAUSE_MS = 250;

let queue: WalletSyncQueue | null | undefined;

const walletQueue = (): WalletSyncQueue | null => {
  if (queue === undefined) queue = buildWalletSyncQueue(prisma);

  return queue;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns how many members were queued. Never throws: a refresh must not fail a save. */
export const refreshClinicCards = async (
  clinicId: string,
  syncQueue: WalletSyncQueue | null = walletQueue()
): Promise<number> => {
  if (!syncQueue) return 0;

  try {
    const members = await prisma.member.findMany({
      where: { clinicId, erasedAt: null, walletObjects: { some: {} } },
      select: { id: true }
    });

    // In batches with a pause: inline mode starts every sync at once, and signing a pass is
    // CPU-bound on the same process that serves reception.
    for (let index = 0; index < members.length; index += BATCH) {
      await Promise.all(
        members.slice(index, index + BATCH).map((member) => syncQueue.enqueueMemberSync(member.id))
      );

      if (index + BATCH < members.length) await pause(PAUSE_MS);
    }

    return members.length;
  } catch (error) {
    console.error("[wallet] could not queue the clinic's cards for refresh", {
      clinicId,
      error: error instanceof Error ? error.message : String(error)
    });

    return 0;
  }
};
