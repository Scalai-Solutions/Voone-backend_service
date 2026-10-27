import { Redis } from "ioredis";
import { Queue, type Worker } from "bullmq";
import {
  NotificationDeliveryStatus,
  NotificationStatus,
  NotificationType,
  WalletProviderType,
  WalletSyncStatus
} from "@prisma/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletNotificationTransientError } from "../../src/common/errors/wallet.errors";
import {
  NOTIFICATIONS_QUEUE,
  createNotificationWorker
} from "../../src/infrastructure/queue/bull-notifications.queue";
import {
  WALLET_SYNC_QUEUE,
  redisConnection
} from "../../src/infrastructure/queue/bull-wallet-sync.queue";
import { NotificationService } from "../../src/modules/notifications/notification.service";

/**
 * Against a REAL Redis: the end of a delivery job's life (every attempt used, the job
 * FAILED in BullMQ) is BullMQ's own behaviour and a mocked Worker cannot reproduce it.
 *
 * Opt-in, with the same guards as bull-queues.redis.test.ts: set TEST_REDIS_URL to a
 * THROWAWAY local Redis, for example
 *   redis-server --port 6392 --save "" --appendonly no
 *   TEST_REDIS_URL=redis://127.0.0.1:6392 npx vitest run tests/queue
 *
 * The suite obliterates the wallet-notifications queue (the production queue name), so it
 * refuses to run unless ALL of these hold: a loopback host; an explicit port that is not
 * Redis's default 6379; no database index 0; and no keys on the instance other than the
 * wallet-notifications and wallet-sync queues' (checked before anything is deleted; the
 * two queue suites may share one throwaway instance). A malformed URL skips the suite.
 *
 * The job is added raw with attempts: 2 and a 10 ms backoff, as the legacy-job test of the
 * wallet-sync suite does, so production's retry policy (5 attempts, 2 s exponential) stays
 * untouched and the test does not wait it out.
 */
const isSafeTestUrl = (value: string | undefined): value is string => {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
    const dbIndex = parsed.pathname.replace(/^\//, "");

    return (
      ["redis:", "rediss:"].includes(parsed.protocol) &&
      loopback &&
      parsed.port !== "" &&
      parsed.port !== "6379" &&
      (dbIndex === "" || (/^\d+$/.test(dbIndex) && Number(dbIndex) !== 0))
    );
  } catch {
    return false;
  }
};
const candidate = process.env.TEST_REDIS_URL;
const enabled = isSafeTestUrl(candidate);
const url = candidate as string;

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
};

/** In-memory tables for one Google delivery of a SINGLE notification. */
const buildWorld = (addObjectMessage: () => Promise<{ messageId: string }>) => {
  const state = {
    deliveryStatus: NotificationDeliveryStatus.QUEUED as NotificationDeliveryStatus,
    errorCode: undefined as string | null | undefined,
    notificationStatus: NotificationStatus.QUEUED as NotificationStatus
  };
  const notification = () => ({
    id: "notification-1",
    clinicId: "clinic-1",
    type: NotificationType.SINGLE,
    header: "Hola",
    body: "cuerpo",
    actionUrl: null,
    notify: false,
    providerMessageId: null,
    status: state.notificationStatus
  });
  const prisma = {
    notificationDelivery: {
      findUnique: async () => ({
        id: "delivery-1",
        notificationId: "notification-1",
        memberId: "member-1",
        provider: WalletProviderType.GOOGLE,
        status: state.deliveryStatus,
        notification: notification(),
        member: {
          walletObjects: [
            {
              provider: WalletProviderType.GOOGLE,
              status: WalletSyncStatus.SYNCED,
              externalObjectId: "google-object-1"
            }
          ]
        }
      }),
      update: async ({
        data
      }: {
        data: { status: NotificationDeliveryStatus; errorCode?: string };
      }) => {
        state.deliveryStatus = data.status;
        state.errorCode = data.errorCode;
      },
      findMany: async () => [{ status: state.deliveryStatus }]
    },
    notification: {
      findUnique: async () => notification(),
      update: async ({ data }: { data: { status?: NotificationStatus } }) => {
        if (data.status) state.notificationStatus = data.status;
      },
      updateMany: async ({ data }: { data: { status?: NotificationStatus } }) => {
        if (data.status) state.notificationStatus = data.status;
        return { count: 1 };
      }
    },
    clinic: { update: async () => undefined }
  };
  const service = new NotificationService(
    prisma as never,
    { addObjectMessage } as never,
    { canMarketingPush: async () => false } as never,
    {} as never,
    null
  );

  return { service, state };
};

describe.skipIf(!enabled)("a delivery job that exhausts its attempts, on a real Redis", () => {
  const workers: Worker[] = [];
  const queues: Array<{ close(): Promise<void> }> = [];

  const wipe = async () => {
    const queue = new Queue(NOTIFICATIONS_QUEUE, { connection: redisConnection(url) });
    await queue.obliterate({ force: true });
    await queue.close();
  };

  beforeAll(async () => {
    // Refuse to touch an instance that holds anything but this queue's own keys.
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

    try {
      const keys = await redis.keys("*");
      const foreign = keys.filter(
        (key) =>
          !key.startsWith(`bull:${NOTIFICATIONS_QUEUE}:`) &&
          !key.startsWith(`bull:${WALLET_SYNC_QUEUE}:`)
      );

      if (foreign.length > 0) {
        throw new Error(
          `TEST_REDIS_URL points at a Redis holding ${foreign.length} key(s) that are not ` +
            `queue keys of this suite's family; refusing to wipe it. Use an empty throwaway instance.`
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

  it("ends with the delivery FAILED JOB_RETRIES_EXHAUSTED and its notification FAILED, without running the message again", async () => {
    let writes = 0;
    const { service, state } = buildWorld(async () => {
      writes += 1;
      throw new WalletNotificationTransientError();
    });
    const inspect = new Queue(NOTIFICATIONS_QUEUE, { connection: redisConnection(url) });
    queues.push(inspect);
    workers.push(createNotificationWorker(url, service));

    await inspect.add(
      "delivery",
      { kind: "delivery", deliveryId: "delivery-1" },
      {
        jobId: "delivery-delivery-1",
        attempts: 2,
        backoff: { type: "fixed", delay: 10 },
        removeOnFail: { age: 7 * 24 * 3_600 }
      }
    );

    expect(await until(() => state.deliveryStatus === NotificationDeliveryStatus.FAILED)).toBe(
      true
    );
    expect(state.errorCode).toBe("JOB_RETRIES_EXHAUSTED");
    expect(state.notificationStatus).toBe(NotificationStatus.FAILED);
    expect((await inspect.getJobCounts("failed")).failed).toBe(1);
    // Terminal: exactly the two attempts BullMQ gave it, and nothing re-enqueued afterwards.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(writes).toBe(2);
    expect(await inspect.getJobCounts("waiting", "delayed", "active")).toMatchObject({
      waiting: 0,
      delayed: 0,
      active: 0
    });
  });

  it("does not close a delivery after an attempt that will be retried and then succeeds", async () => {
    let writes = 0;
    const { service, state } = buildWorld(async () => {
      writes += 1;
      if (writes === 1) throw new WalletNotificationTransientError();
      return { messageId: "google-msg-1" };
    });
    const inspect = new Queue(NOTIFICATIONS_QUEUE, { connection: redisConnection(url) });
    queues.push(inspect);
    workers.push(createNotificationWorker(url, service));

    await inspect.add(
      "delivery",
      { kind: "delivery", deliveryId: "delivery-1" },
      { jobId: "delivery-delivery-1", attempts: 2, backoff: { type: "fixed", delay: 10 } }
    );

    expect(await until(() => state.deliveryStatus === NotificationDeliveryStatus.SENT)).toBe(true);
    expect(state.errorCode).toBeNull();
    expect(state.notificationStatus).toBe(NotificationStatus.SENT);
  });
});
