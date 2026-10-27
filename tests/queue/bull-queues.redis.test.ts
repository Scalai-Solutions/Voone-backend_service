import { Queue, type Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BullNotificationQueue,
  NOTIFICATIONS_QUEUE,
  createNotificationWorker
} from "../../src/infrastructure/queue/bull-notifications.queue";
import {
  BullWalletSyncQueue,
  WALLET_SYNC_QUEUE,
  createWalletSyncWorker,
  redisConnection
} from "../../src/infrastructure/queue/bull-wallet-sync.queue";
import type { NotificationService } from "../../src/modules/notifications/notification.service";
import type { WalletSyncService } from "../../src/wallet/engine/wallet-sync.service";

/**
 * Against a REAL Redis, because the bug these guard against is BullMQ's own behaviour
 * (an add with an existing job id is ignored in any state) and a mocked Queue cannot
 * reproduce it.
 *
 * Opt-in: set TEST_REDIS_URL to a throwaway local Redis, for example
 *   redis-server --port 6390 --save "" --appendonly no
 *   TEST_REDIS_URL=redis://127.0.0.1:6390 npx vitest run tests/queue
 *
 * It obliterates the two queues it uses, so it refuses anything that is not loopback.
 */
const url = process.env.TEST_REDIS_URL;
const isLoopback = (value: string) =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname);
const enabled = Boolean(url) && isLoopback(url as string);

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
    for (const name of [WALLET_SYNC_QUEUE, NOTIFICATIONS_QUEUE]) {
      const queue = new Queue(name, { connection: redisConnection(url as string) });
      await queue.obliterate({ force: true });
      await queue.close();
    }
  };

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
    const syncMember = vi.fn(async (_memberId: string) => []);
    const service = { syncMember } as unknown as WalletSyncService;
    const queue = new BullWalletSyncQueue(url as string);
    queues.push(queue);
    workers.push(createWalletSyncWorker(url as string, service));
    const inspect = new Queue(WALLET_SYNC_QUEUE, { connection: redisConnection(url as string) });
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
    const syncMember = vi.fn(async (_memberId: string) => []);
    const service = { syncMember } as unknown as WalletSyncService;
    const queue = new BullWalletSyncQueue(url as string);
    queues.push(queue);
    const inspect = new Queue(WALLET_SYNC_QUEUE, { connection: redisConnection(url as string) });
    queues.push(inspect);
    // What the previous release leaves in Redis for up to seven days: a job that ran out
    // of its attempts under the fixed id. Added raw with attempts: 1 so the test does not
    // wait out the exponential backoff.
    await inspect.add(
      WALLET_SYNC_QUEUE,
      { memberId: "member-2" },
      { jobId: "member-member-2", attempts: 1 }
    );
    const failing = createWalletSyncWorker(
      url as string,
      {
        syncMember: async () => [{ provider: "APPLE", result: "failed" }]
      } as unknown as WalletSyncService
    );
    workers.push(failing);
    expect(await until(async () => (await inspect.getJobCounts("failed")).failed === 1)).toBe(true);
    await failing.close();
    workers.splice(0);

    workers.push(createWalletSyncWorker(url as string, service));
    await queue.enqueueMemberSync("member-2");

    expect(await until(() => syncMember.mock.calls.length === 1)).toBe(true);
  });

  it("re-enqueues a delivery whose earlier job FAILED, so a QUEUED delivery is not stranded", async () => {
    const processDelivery = vi.fn(async (_deliveryId: string) => undefined);
    const inspect = new Queue(NOTIFICATIONS_QUEUE, { connection: redisConnection(url as string) });
    queues.push(inspect);
    const queue = new BullNotificationQueue(url as string);
    queues.push(queue);
    // The job a transient wallet outage leaves behind once its attempts are spent (the
    // delivery row stays QUEUED): same id the real enqueue uses.
    await inspect.add(
      "delivery",
      { kind: "delivery", deliveryId: "d-1" },
      { jobId: "delivery-d-1", attempts: 1 }
    );
    const failing = createNotificationWorker(
      url as string,
      {
        processDelivery: async () => {
          throw new Error("transient");
        }
      } as unknown as NotificationService
    );
    workers.push(failing);
    expect(await until(async () => (await inspect.getJobCounts("failed")).failed === 1)).toBe(true);
    await failing.close();
    workers.splice(0);

    workers.push(
      createNotificationWorker(url as string, { processDelivery } as unknown as NotificationService)
    );
    await queue.enqueueDelivery("d-1");

    expect(await until(() => processDelivery.mock.calls.length === 1)).toBe(true);
  });

  it("still collapses a duplicate enqueue of a delivery that is waiting", async () => {
    const inspect = new Queue(NOTIFICATIONS_QUEUE, { connection: redisConnection(url as string) });
    queues.push(inspect);
    const queue = new BullNotificationQueue(url as string);
    queues.push(queue);

    await queue.enqueueDelivery("d-2", 60_000);
    await queue.enqueueDelivery("d-2", 60_000);
    await queue.enqueueNotification("n-1", 60_000);
    await queue.enqueueNotification("n-1", 60_000);

    const counts = await inspect.getJobCounts("delayed", "waiting");
    expect(counts.delayed + counts.waiting).toBe(2);
  });
});
