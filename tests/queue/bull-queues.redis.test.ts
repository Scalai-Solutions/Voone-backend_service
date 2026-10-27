import { Redis } from "ioredis";
import { Queue, type Worker } from "bullmq";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NOTIFICATIONS_QUEUE } from "../../src/infrastructure/queue/bull-notifications.queue";
import {
  BullWalletSyncQueue,
  WALLET_SYNC_QUEUE,
  createWalletSyncWorker,
  redisConnection
} from "../../src/infrastructure/queue/bull-wallet-sync.queue";
import { isSafeTestRedisUrl } from "./redis-test-url";
import type { WalletSyncService } from "../../src/wallet/engine/wallet-sync.service";

/**
 * Against a REAL Redis, because the bug this guards against is BullMQ's own behaviour
 * (an add with an existing job id is ignored in any state) and a mocked Queue cannot
 * reproduce it.
 *
 * Opt-in: set TEST_REDIS_URL to a THROWAWAY local Redis, for example
 *   redis-server --port 6390 --save "" --appendonly no
 *   TEST_REDIS_URL=redis://127.0.0.1:6390/1 npx vitest run tests/queue
 *
 * The suite obliterates the wallet-sync queue (the production queue name: the code under
 * test takes no queue-name override), so it refuses to run unless ALL of these hold:
 *  - a loopback host;
 *  - an explicit port that is not Redis's default 6379, so a developer's everyday Redis
 *    is never the target by accident;
 *  - an explicit, non-zero database index on the URL (index 0 is where everything else
 *    lives; a URL without a database path is refused too);
 *  - the instance holds no keys other than BullMQ's wallet-sync and wallet-notifications
 *    ones (checked before anything is deleted; a dev Redis with other data fails loudly
 *    instead of being wiped). Both queue suites may share one throwaway instance: each only
 *    ever wipes its own queue.
 * A malformed URL skips the suite rather than throwing at import.
 */
const candidate = process.env.TEST_REDIS_URL;
const enabled = isSafeTestRedisUrl(candidate);
const url = candidate as string;

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
};

describe.skipIf(!enabled)("BullMQ queues against a real Redis", () => {
  const workers: Worker[] = [];
  const queues: Array<{ close(): Promise<void> }> = [];

  const wipe = async () => {
    for (const name of [WALLET_SYNC_QUEUE]) {
      const queue = new Queue(name, { connection: redisConnection(url) });
      await queue.obliterate({ force: true });
      await queue.close();
    }
  };

  beforeAll(async () => {
    // Refuse to touch an instance that holds anything but this queue's own keys.
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

    try {
      const keys = await redis.keys("*");
      const foreign = keys.filter(
        (key) =>
          !key.startsWith(`bull:${WALLET_SYNC_QUEUE}:`) &&
          !key.startsWith(`bull:${NOTIFICATIONS_QUEUE}:`)
      );

      if (foreign.length > 0) {
        throw new Error(
          `TEST_REDIS_URL points at a Redis holding ${foreign.length} key(s) that are not ` +
            `${WALLET_SYNC_QUEUE} queue keys; refusing to wipe it. Use an empty throwaway instance.`
        );
      }
    } finally {
      redis.disconnect();
    }
  });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await wipe();
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
    await wipe();
  });

  it("syncs a member again after the first sync job has COMPLETED", async () => {
    const syncMember = vi.fn(async (_memberId: string) => ({ outcomes: [], stale: false }));
    const service = { syncMemberChecked: syncMember } as unknown as WalletSyncService;
    const queue = new BullWalletSyncQueue(url);
    queues.push(queue);
    workers.push(createWalletSyncWorker(url, service));
    const inspect = new Queue(WALLET_SYNC_QUEUE, { connection: redisConnection(url) });
    queues.push(inspect);

    await queue.enqueueMemberSync("member-1");
    expect(await until(() => syncMember.mock.calls.length === 1)).toBe(true);
    // The first job must be sitting in the completed set: that is exactly the state in
    // which the old fixed job id swallowed every later add.
    expect(await until(async () => (await inspect.getJobCounts("completed")).completed === 1)).toBe(
      true
    );

    await queue.enqueueMemberSync("member-1");
    await queue.enqueueMemberSync("member-1");

    expect(await until(() => syncMember.mock.calls.length === 3)).toBe(true);
    expect(syncMember.mock.calls.map((call) => call[0])).toEqual([
      "member-1",
      "member-1",
      "member-1"
    ]);
  });

  it("syncs a member despite a legacy FAILED job still holding the old member-<id> job id", async () => {
    const syncMember = vi.fn(async (_memberId: string) => ({ outcomes: [], stale: false }));
    const service = { syncMemberChecked: syncMember } as unknown as WalletSyncService;
    const queue = new BullWalletSyncQueue(url);
    queues.push(queue);
    const inspect = new Queue(WALLET_SYNC_QUEUE, { connection: redisConnection(url) });
    queues.push(inspect);
    // What the previous release leaves in Redis for up to seven days: a job that ran out
    // of its attempts under the fixed id. Added raw with attempts: 1 so the test does not
    // wait out the exponential backoff.
    await inspect.add(
      WALLET_SYNC_QUEUE,
      { memberId: "member-2" },
      { jobId: "member-member-2", attempts: 1 }
    );
    const failing = createWalletSyncWorker(url, {
      syncMemberChecked: async () => ({
        outcomes: [{ provider: "APPLE", result: "failed" }],
        stale: false
      })
    } as unknown as WalletSyncService);
    workers.push(failing);
    expect(await until(async () => (await inspect.getJobCounts("failed")).failed === 1)).toBe(true);
    await failing.close();
    workers.splice(0);

    workers.push(createWalletSyncWorker(url, service));
    await queue.enqueueMemberSync("member-2");

    expect(await until(() => syncMember.mock.calls.length === 1)).toBe(true);
  });

  it("chases a card that changed during a sync with one follow-up job carrying recheck: 1", async () => {
    // Stale on the first run only: the follow-up finds the card settled and ends the chain.
    const syncMember = vi.fn(async (_memberId: string) => ({
      outcomes: [],
      stale: syncMember.mock.calls.length === 1
    }));
    const queue = new BullWalletSyncQueue(url);
    queues.push(queue);
    workers.push(
      createWalletSyncWorker(url, { syncMemberChecked: syncMember } as unknown as WalletSyncService)
    );
    const inspect = new Queue(WALLET_SYNC_QUEUE, { connection: redisConnection(url) });
    queues.push(inspect);

    await queue.enqueueMemberSync("member-3");

    expect(await until(async () => (await inspect.getJobCounts("completed")).completed === 2)).toBe(
      true
    );
    expect(syncMember).toHaveBeenCalledTimes(2);
    const data = (await inspect.getJobs(["completed"]))
      .map((job) => job.data)
      .sort((a, b) => (a.recheck ?? 0) - (b.recheck ?? 0));
    expect(data).toEqual([{ memberId: "member-3" }, { memberId: "member-3", recheck: 1 }]);
  });

  it("stops chasing a card that never settles after 3 re-checks, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const syncMember = vi.fn(async (_memberId: string) => ({ outcomes: [], stale: true }));
    const queue = new BullWalletSyncQueue(url);
    queues.push(queue);
    workers.push(
      createWalletSyncWorker(url, { syncMemberChecked: syncMember } as unknown as WalletSyncService)
    );
    const inspect = new Queue(WALLET_SYNC_QUEUE, { connection: redisConnection(url) });
    queues.push(inspect);

    await queue.enqueueMemberSync("member-4");

    expect(await until(async () => (await inspect.getJobCounts("completed")).completed === 4)).toBe(
      true
    );
    // Give a wrongly enqueued fifth job the chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(syncMember).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      "[wallet] sync for member member-4 still changing after 3 re-checks"
    );
  });
});
