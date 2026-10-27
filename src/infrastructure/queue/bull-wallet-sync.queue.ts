import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";

import { WalletSyncQueue } from "../../wallet/engine/wallet-sync.queue";
import { WalletSyncService } from "../../wallet/engine/wallet-sync.service";

export const WALLET_SYNC_QUEUE = "wallet-sync";

export interface WalletSyncJob {
  memberId: string;
}

/**
 * BullMQ's connection accepts a URL directly, so nothing here imports a Redis client.
 *
 * It still needs one installed. BullMQ 6 moved ioredis from a direct dependency to an
 * OPTIONAL peer, so the package resolves and type-checks and builds without it, then
 * fails at runtime with "could not load the optional 'ioredis' package" the first time a
 * queue or worker is constructed — which is only ever when WALLET_SYNC_MODE=queue. That
 * is why this survived every CI run and only surfaced on the deploy that flipped the
 * mode. ioredis is therefore a real dependency in package.json, pinned to ^5: BullMQ
 * 6.3.8 declares >=5.0.0 but is tested against 5.11.x, and this is not the place to be
 * the first to try a new major.
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
 * Every change enqueues its own job. The job carries only the member id and the sync
 * rebuilds the whole card from the database when the job RUNS, so a job is "bring this
 * member up to date as of now": N changes in a burst cost up to N idempotent syncs, and
 * each of them runs after the change that requested it.
 *
 * Do NOT give these jobs an id derived from the member (`member-<id>`), and do not turn
 * on BullMQ `deduplication`, to "collapse a burst":
 *  - BullMQ ignores an add whose job id already exists in ANY state. This queue keeps
 *    completed jobs for an hour and failed jobs for seven days, so after a member's first
 *    sync every later change was silently dropped for that long (a visit credited three
 *    times left the Apple card on the first balance forever, and no push ever fired).
 *  - Deduplication in simple mode also drops an add made while a job is active, and that
 *    job may already have read the member's state, so the new change would be lost.
 * Retention is therefore harmless here: a finished job can never block a later one.
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
      // No jobId on purpose, so BullMQ generates a unique one and this add can never be
      // ignored because an earlier job for the member still exists (see the class
      // comment). Every change gets a sync that runs after it.
      await this.queue.add(WALLET_SYNC_QUEUE, { memberId });
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
