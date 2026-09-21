import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";

import { WalletSyncQueue } from "../../wallet/engine/wallet-sync.queue";
import { WalletSyncService } from "../../wallet/engine/wallet-sync.service";

export const WALLET_SYNC_QUEUE = "wallet-sync";

export interface WalletSyncJob {
  memberId: string;
}

/**
 * BullMQ's connection accepts a URL directly, so nothing here imports a Redis client and
 * the backend keeps one fewer dependency it would have to keep in step.
 */
export const redisConnection = (url: string): ConnectionOptions => ({
  url,
  // BullMQ requires this to be null on the connections it blocks on, and says so at
  // runtime rather than at compile time. Set here so both queue and worker inherit it.
  maxRetriesPerRequest: null
});

/**
 * The durable queue.
 *
 * Jobs are keyed by member, so a member whose points change five times in a burst is
 * synced once rather than five times — the wallet only ever shows the latest state, so
 * collapsing them is correct and not merely an optimisation.
 */
export class BullWalletSyncQueue implements WalletSyncQueue {
  private readonly queue: Queue<WalletSyncJob>;

  constructor(redisUrl: string) {
    this.queue = new Queue<WalletSyncJob>(WALLET_SYNC_QUEUE, {
      connection: redisConnection(redisUrl),
      defaultJobOptions: {
        attempts: 5,
        // A wallet API that is down tends to stay down for a while; backing off linearly
        // would spend all five attempts inside the first minute.
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        // Kept longer than completed: a failed sync is a member whose card is stale, and
        // that is the thing worth being able to look up after the fact.
        removeOnFail: { age: 7 * 24 * 3_600 }
      }
    });
  }

  async enqueueMemberSync(memberId: string): Promise<void> {
    try {
      await this.queue.add(
        WALLET_SYNC_QUEUE,
        { memberId },
        // Deduplicates a burst into one job. A job already running is not replaced —
        // the next change enqueues again, so nothing is dropped.
        { jobId: `member:${memberId}` }
      );
    } catch (cause) {
      // Enqueueing must never fail the caller: Redis being unreachable is an operational
      // problem, not a reason to reject a visit at reception.
      console.error(`[wallet] could not enqueue sync for member ${memberId}:`, cause);
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * The worker side. Separate from the queue so the API process can enqueue without also
 * becoming a consumer.
 */
export const createWalletSyncWorker = (
  redisUrl: string,
  service: WalletSyncService,
  concurrency = 5
): Worker<WalletSyncJob> =>
  new Worker<WalletSyncJob>(
    WALLET_SYNC_QUEUE,
    async (job: Job<WalletSyncJob>) => {
      const outcomes = await service.syncMember(job.data.memberId);
      const failed = outcomes.filter((outcome) => outcome.result === "failed");

      // Rethrowing is what earns a retry. Reported as one failure even when both
      // providers fell over, because the job is "make this member current" and it is
      // retried whole.
      if (failed.length > 0) {
        throw new Error(
          `wallet sync failed for ${job.data.memberId}: ${failed
            .map((outcome) => outcome.provider)
            .join(", ")}`
        );
      }

      return outcomes;
    },
    { connection: redisConnection(redisUrl), concurrency }
  );
