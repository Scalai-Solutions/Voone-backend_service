import { prisma } from "../../infrastructure/database/prisma-client";
import type { WalletSyncQueue } from "../../wallet/engine/wallet-sync.queue";
import { buildWalletSyncQueue } from "../../wallet/wallet.composition";
import { refreshGoogleClasses } from "./google-class-refresh";

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

/** The one queue this process's refreshes share, built on first use. */
export const walletQueue = (): WalletSyncQueue | null => {
  if (queue === undefined) queue = buildWalletSyncQueue(prisma);

  return queue;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One sync per member, in batches with a pause: inline mode starts every sync at once, and
 * signing a pass is CPU-bound on the same process that serves reception.
 */
export const enqueueInBatches = async (
  syncQueue: WalletSyncQueue,
  memberIds: string[]
): Promise<void> => {
  for (let index = 0; index < memberIds.length; index += BATCH) {
    await Promise.all(
      memberIds.slice(index, index + BATCH).map((memberId) => syncQueue.enqueueMemberSync(memberId))
    );

    if (index + BATCH < memberIds.length) await pause(PAUSE_MS);
  }
};

const refreshClinicGoogleClasses = async (clinicId: string): Promise<void> => {
  await refreshGoogleClasses({ clinicId, apply: true });
};

/**
 * Returns how many members were queued. Never throws: a refresh must not fail a save.
 *
 * The clinic's Google class is re-PATCHed first, because a recorded class is otherwise never
 * touched again. That step is non-fatal and never holds up the member refresh.
 */
export const refreshClinicCards = async (
  clinicId: string,
  syncQueue: WalletSyncQueue | null = walletQueue(),
  refreshClasses: (clinicId: string) => Promise<void> = refreshClinicGoogleClasses
): Promise<number> => {
  try {
    await refreshClasses(clinicId);
  } catch (error) {
    console.error("[wallet] could not refresh the clinic's Google class", {
      clinicId,
      error: error instanceof Error ? error.name : "unknown"
    });
  }

  if (!syncQueue) return 0;

  try {
    const members = await prisma.member.findMany({
      where: { clinicId, erasedAt: null, walletObjects: { some: {} } },
      select: { id: true }
    });

    await enqueueInBatches(
      syncQueue,
      members.map((member) => member.id)
    );

    return members.length;
  } catch (error) {
    console.error("[wallet] could not queue the clinic's cards for refresh", {
      clinicId,
      error: error instanceof Error ? error.message : String(error)
    });

    return 0;
  }
};
